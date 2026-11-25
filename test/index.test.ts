import { createRequire } from "node:module";
import { expect, test } from "vitest";
import {
  AbortedTransactionError,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type AbortableOperationOptions,
  type DatabaseConnection,
  type TransactionSettings,
} from "kysely";
import { startConnection, startSavePoint, startTransaction } from "../src/index.js";

interface Database {
  person: { id: number; name: string };
}

class RecordingDriver extends DummyDriver {
  readonly events: string[] = [];
  readonly failures = new Map<string, Error>();
  readonly connectionOptions: (AbortableOperationOptions | undefined)[] = [];
  readonly transactionSettings: TransactionSettings[] = [];
  fail: string | undefined;
  releaseGate?: Promise<void>;

  private record(event: string): void {
    this.events.push(event);
    const error = this.failures.get(event);
    if (error) throw error;
    if (this.fail === event) throw new Error(event);
  }

  override async acquireConnection(options?: AbortableOperationOptions) {
    this.connectionOptions.push(options);
    this.record("acquire");
    return super.acquireConnection();
  }

  override async releaseConnection(
    _connection?: DatabaseConnection,
    options?: AbortableOperationOptions,
  ): Promise<void> {
    this.connectionOptions.push(options);
    await this.releaseGate;
    this.record("release");
  }

  override async beginTransaction(
    _connection?: DatabaseConnection,
    settings?: TransactionSettings,
  ): Promise<void> {
    if (settings) {
      this.transactionSettings.push(settings);
    }
    this.record("begin");
    await super.beginTransaction();
  }

  override async commitTransaction(): Promise<void> {
    this.record("commit");
    await super.commitTransaction();
  }

  override async rollbackTransaction(): Promise<void> {
    this.record("rollback");
    await super.rollbackTransaction();
  }

  override async savepoint(): Promise<void> {
    this.record("savepoint");
    await super.savepoint();
  }

  override async releaseSavepoint(): Promise<void> {
    this.record("release-savepoint");
    await super.releaseSavepoint();
  }

  override async rollbackToSavepoint(): Promise<void> {
    this.record("rollback-savepoint");
    await super.rollbackToSavepoint();
  }
}

function createDatabase() {
  const driver = new RecordingDriver();
  const db = new Kysely<Database>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: (database) => new PostgresIntrospector(database),
    },
  });
  return { db, driver };
}

test("connection stays acquired until await using exits", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using connection = await startConnection(db);
      expect(connection.db).not.toBe(db);
      await connection.db.selectFrom("person").selectAll().execute();
      expect(driver.events).toEqual(["acquire"]);
    }
    expect(driver.events).toEqual(["acquire", "release"]);
  } finally {
    await db.destroy();
  }
});

test("all concurrent release callers wait for cleanup, including disposal", async () => {
  const { db, driver } = createDatabase();
  const gate = Promise.withResolvers<undefined>();
  driver.releaseGate = gate.promise;
  try {
    const connection = await startConnection(db);
    const first = connection.release();
    let completed = false;
    const second = connection.release().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    gate.resolve(undefined);
    await Promise.all([first, second, connection[Symbol.asyncDispose]()]);
    expect(driver.events).toEqual(["acquire", "release"]);
  } finally {
    gate.resolve(undefined);
    await db.destroy();
  }
});

test("connection acquisition failure rejects instead of hanging", { timeout: 1000 }, async () => {
  const { db, driver } = createDatabase();
  driver.fail = "acquire";
  try {
    await expect(startConnection(db)).rejects.toThrow("acquire");
  } finally {
    await db.destroy();
  }
});

test("connection release failures reach every caller", async () => {
  const { db, driver } = createDatabase();
  try {
    const connection = await startConnection(db);
    driver.fail = "release";
    await expect(connection.release()).rejects.toThrow("release");
    await expect(connection[Symbol.asyncDispose]()).rejects.toThrow("release");
  } finally {
    await db.destroy();
  }
});

test("connection is released when the scope body throws", async () => {
  const { db, driver } = createDatabase();
  try {
    await expect(async () => {
      await using connection = await startConnection(db);
      expect(connection.db).toBeTruthy();
      throw new Error("body");
    }).rejects.toThrow("body");
    expect(driver.events).toEqual(["acquire", "release"]);
  } finally {
    await db.destroy();
  }
});

test("transaction disposal rolls back on normal and exceptional scope exit", async () => {
  for (const throws of [false, true]) {
    const { db, driver } = createDatabase();
    try {
      const body = async () => {
        await using tx = await startTransaction(db);
        await tx.transaction.selectFrom("person").selectAll().execute();
        if (throws) throw new Error("body");
      };
      if (throws) await expect(body()).rejects.toThrow("body");
      else await body();
      expect(driver.events).toEqual(["acquire", "begin", "rollback", "release"]);
    } finally {
      await db.destroy();
    }
  }
});

test("explicit commit and rollback prevent disposal from rolling back again", async () => {
  for (const action of ["commit", "rollback"] as const) {
    const { db, driver } = createDatabase();
    try {
      {
        await using tx = await startTransaction(db);
        await tx[action]();
      }
      expect(driver.events).toEqual(["acquire", "begin", action, "release"]);
    } finally {
      await db.destroy();
    }
  }
});

test("disposal respects transactions finalized through the exposed Kysely object", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using tx = await startTransaction(db);
      await tx.transaction.commit().execute();
    }
    expect(driver.events).toEqual(["acquire", "begin", "commit", "release"]);
  } finally {
    await db.destroy();
  }
});

test("failed commit propagates and disposal still rolls back", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using tx = await startTransaction(db);
      driver.fail = "commit";
      await expect(tx.commit()).rejects.toThrow("commit");
    }
    expect(driver.events).toEqual(["acquire", "begin", "commit", "rollback", "release"]);
  } finally {
    await db.destroy();
  }
});

test("uncaught commit failure rolls back before the original error leaves the scope", async () => {
  const { db, driver } = createDatabase();
  const commitError = new Error("commit failed");
  driver.failures.set("commit", commitError);
  try {
    let caught: unknown;
    try {
      await using tx = await startTransaction(db);
      await tx.commit();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(commitError);
    expect(driver.events).toEqual(["acquire", "begin", "commit", "rollback", "release"]);
  } finally {
    await db.destroy();
  }
});

test("explicit rollback after commit failure is not repeated on disposal", async () => {
  const { db, driver } = createDatabase();
  const commitError = new Error("commit failed");
  driver.failures.set("commit", commitError);
  try {
    {
      await using tx = await startTransaction(db);
      try {
        await tx.commit();
        expect.unreachable("commit must reject");
      } catch (error) {
        expect(error).toBe(commitError);
        expect(tx.transaction.isCommitted).toBe(false);
        expect(tx.transaction.isRolledBack).toBe(false);
        await tx.rollback();
        expect(tx.transaction.isRolledBack).toBe(true);
      }
    }
    expect(driver.events).toEqual(["acquire", "begin", "commit", "rollback", "release"]);
  } finally {
    await db.destroy();
  }
});

test("commit and rollback failures produce SuppressedError with both original errors", async () => {
  const { db, driver } = createDatabase();
  const commitError = new Error("commit failed");
  const rollbackError = new Error("rollback failed");
  driver.failures.set("commit", commitError);
  driver.failures.set("rollback", rollbackError);
  try {
    let caught: unknown;
    try {
      await using tx = await startTransaction(db);
      await tx.commit();
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error)) expect.unreachable("expected Error");
    expect(caught.name).toBe("SuppressedError");
    if (!("error" in caught && "suppressed" in caught)) {
      expect.unreachable("expected SuppressedError fields");
    }
    expect(caught.error).toBe(rollbackError);
    expect(caught.suppressed).toBe(commitError);
    expect(driver.events).toEqual(["acquire", "begin", "commit", "rollback", "release"]);
  } finally {
    await db.destroy();
  }
});

test("body throw and rollback failure produce SuppressedError with both original errors", async () => {
  const { db, driver } = createDatabase();
  const bodyError = new Error("body failed");
  const rollbackError = new Error("rollback failed");
  driver.failures.set("rollback", rollbackError);
  try {
    let caught: unknown;
    try {
      await using tx = await startTransaction(db);
      expect(tx.transaction).toBeTruthy();
      throw bodyError;
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error)) expect.unreachable("expected Error");
    expect(caught.name).toBe("SuppressedError");
    if (!("error" in caught && "suppressed" in caught)) {
      expect.unreachable("expected SuppressedError fields");
    }
    expect(caught.error).toBe(rollbackError);
    expect(caught.suppressed).toBe(bodyError);
    expect(driver.events).toEqual(["acquire", "begin", "rollback", "release"]);
  } finally {
    await db.destroy();
  }
});

test("database-aborted commit does not send a redundant rollback on disposal", async () => {
  const { db, driver } = createDatabase();
  const commitError = new AbortedTransactionError();
  driver.failures.set("commit", commitError);
  try {
    let caught: unknown;
    try {
      await using tx = await startTransaction(db);
      await tx.commit();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(commitError);
    expect(driver.events).toEqual(["acquire", "begin", "commit", "release"]);
  } finally {
    await db.destroy();
  }
});

test("transaction startup and rollback failures propagate", async () => {
  for (const failure of ["begin", "rollback"]) {
    const { db, driver } = createDatabase();
    driver.fail = failure;
    try {
      await expect(async () => {
        await using tx = await startTransaction(db);
        expect(tx.transaction).toBeTruthy();
      }).rejects.toThrow(failure);
    } finally {
      await db.destroy();
    }
  }
});

test("savepoint disposal rolls back without ending the outer transaction", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using tx = await startTransaction(db);
      {
        await using outer = await startSavePoint(tx.transaction, "outer");
        {
          await using inner = await startSavePoint(outer.transaction, "inner");
          await inner.transaction.selectFrom("person").selectAll().execute();
        }
        await outer.release();
      }
      await tx.commit();
    }
    expect(driver.events).toEqual([
      "acquire", "begin", "savepoint", "savepoint", "rollback-savepoint",
      "release-savepoint", "commit", "release",
    ]);
  } finally {
    await db.destroy();
  }
});

test("explicit savepoint release and rollback prevent a second disposal command", async () => {
  for (const action of ["release", "rollback"] as const) {
    const { db, driver } = createDatabase();
    try {
      {
        await using tx = await startTransaction(db);
        {
          await using sp = await startSavePoint(tx.transaction, "point");
          await sp[action]();
          await sp[Symbol.asyncDispose]();
        }
      }
      expect(driver.events).toEqual([
        "acquire", "begin", "savepoint", `${action}-savepoint`, "rollback", "release",
      ]);
    } finally {
      await db.destroy();
    }
  }
});

test("savepoint rolls back when the scope body throws", async () => {
  const { db, driver } = createDatabase();
  try {
    await expect(async () => {
      await using tx = await startTransaction(db);
      await using sp = await startSavePoint(tx.transaction, "point");
      expect(sp.transaction).toBeTruthy();
      throw new Error("body");
    }).rejects.toThrow("body");
    expect(driver.events).toEqual([
      "acquire", "begin", "savepoint", "rollback-savepoint", "rollback", "release",
    ]);
  } finally {
    await db.destroy();
  }
});

test("savepoint creation, release, and rollback failures propagate", async () => {
  for (const failure of ["savepoint", "release-savepoint", "rollback-savepoint"]) {
    const { db, driver } = createDatabase();
    try {
      await using tx = await startTransaction(db);
      driver.fail = failure;
      if (failure === "savepoint") {
        await expect(startSavePoint(tx.transaction, "point")).rejects.toThrow(failure);
      } else {
        const sp = await startSavePoint(tx.transaction, "point");
        const action = () => failure === "release-savepoint" ? sp.release() : sp.rollback();
        await expect(action()).rejects.toThrow(failure);
        driver.fail = undefined;
        await sp[Symbol.asyncDispose]();
        expect(
          driver.events.filter((event) => event === "rollback-savepoint").length,
        ).toBe(failure === "rollback-savepoint" ? 2 : 1);
      }
    } finally {
      await db.destroy();
    }
  }
});

test("startConnection forwards AbortableOperationOptions", async () => {
  const { db, driver } = createDatabase();
  const controller = new AbortController();
  try {
    {
      await using connection = await startConnection(db, { signal: controller.signal });
      expect(connection.db).toBeTruthy();
    }
    expect(driver.connectionOptions).toEqual([
      { signal: controller.signal },
      { signal: controller.signal },
    ]);
  } finally {
    await db.destroy();
  }
});

test("startTransaction accepts options object and builder callback", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using tx = await startTransaction(db, {
        isolationLevel: "serializable",
        accessMode: "read only",
      });
      await tx.commit();
    }
    {
      await using tx = await startTransaction(db, {});
      await tx.commit();
    }
    {
      await using tx = await startTransaction(db, (builder) =>
        builder.setIsolationLevel("repeatable read").setAccessMode("read write"),
      );
      await tx.commit();
    }
    expect(driver.transactionSettings).toEqual([
      { isolationLevel: "serializable", accessMode: "read only" },
      { isolationLevel: undefined, accessMode: undefined },
      { isolationLevel: "repeatable read", accessMode: "read write" },
    ]);
  } finally {
    await db.destroy();
  }
});

test("package exports support CommonJS require()", () => {
  const require = createRequire(import.meta.url);
  const cjsModule = require("kysely-scoped-helper") as Record<string, unknown>;
  expect(typeof cjsModule.startConnection).toBe("function");
  expect(typeof cjsModule.startTransaction).toBe("function");
  expect(typeof cjsModule.startSavePoint).toBe("function");
});
