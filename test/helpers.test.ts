import assert from "node:assert/strict";
import { test } from "node:test";
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

await test("connection stays acquired until await using exits", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using connection = await startConnection(db);
      assert.notEqual(connection.db, db);
      await connection.db.selectFrom("person").selectAll().execute();
      assert.deepEqual(driver.events, ["acquire"]);
    }
    assert.deepEqual(driver.events, ["acquire", "release"]);
  } finally {
    await db.destroy();
  }
});

await test("all concurrent release callers wait for cleanup, including disposal", async () => {
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
    assert.equal(completed, false);
    gate.resolve(undefined);
    await Promise.all([first, second, connection[Symbol.asyncDispose]()]);
    assert.deepEqual(driver.events, ["acquire", "release"]);
  } finally {
    gate.resolve(undefined);
    await db.destroy();
  }
});

await test("connection acquisition failure rejects instead of hanging", { timeout: 1000 }, async () => {
  const { db, driver } = createDatabase();
  driver.fail = "acquire";
  try {
    await assert.rejects(startConnection(db), { message: "acquire" });
  } finally {
    await db.destroy();
  }
});

await test("connection release failures reach every caller", async () => {
  const { db, driver } = createDatabase();
  try {
    const connection = await startConnection(db);
    driver.fail = "release";
    await assert.rejects(connection.release(), { message: "release" });
    await assert.rejects(connection[Symbol.asyncDispose](), { message: "release" });
  } finally {
    await db.destroy();
  }
});

await test("connection is released when the scope body throws", async () => {
  const { db, driver } = createDatabase();
  try {
    await assert.rejects(async () => {
      await using connection = await startConnection(db);
      assert.ok(connection.db);
      throw new Error("body");
    }, { message: "body" });
    assert.deepEqual(driver.events, ["acquire", "release"]);
  } finally {
    await db.destroy();
  }
});

await test("transaction disposal rolls back on normal and exceptional scope exit", async () => {
  for (const throws of [false, true]) {
    const { db, driver } = createDatabase();
    try {
      const body = async () => {
        await using tx = await startTransaction(db);
        await tx.transaction.selectFrom("person").selectAll().execute();
        if (throws) throw new Error("body");
      };
      if (throws) await assert.rejects(body, { message: "body" });
      else await body();
      assert.deepEqual(driver.events, ["acquire", "begin", "rollback", "release"]);
    } finally {
      await db.destroy();
    }
  }
});

await test("explicit commit and rollback prevent disposal from rolling back again", async () => {
  for (const action of ["commit", "rollback"] as const) {
    const { db, driver } = createDatabase();
    try {
      {
        await using tx = await startTransaction(db);
        await tx[action]();
      }
      assert.deepEqual(driver.events, ["acquire", "begin", action, "release"]);
    } finally {
      await db.destroy();
    }
  }
});

await test("disposal respects transactions finalized through the exposed Kysely object", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using tx = await startTransaction(db);
      await tx.transaction.commit().execute();
    }
    assert.deepEqual(driver.events, ["acquire", "begin", "commit", "release"]);
  } finally {
    await db.destroy();
  }
});

await test("failed commit propagates and disposal still rolls back", async () => {
  const { db, driver } = createDatabase();
  try {
    {
      await using tx = await startTransaction(db);
      driver.fail = "commit";
      await assert.rejects(tx.commit(), { message: "commit" });
    }
    assert.deepEqual(driver.events, ["acquire", "begin", "commit", "rollback", "release"]);
  } finally {
    await db.destroy();
  }
});

await test("uncaught commit failure rolls back before the original error leaves the scope", async () => {
  const { db, driver } = createDatabase();
  const commitError = new Error("commit failed");
  driver.failures.set("commit", commitError);
  try {
    await assert.rejects(async () => {
      await using tx = await startTransaction(db);
      await tx.commit();
    }, (error: unknown) => {
      assert.equal(error, commitError);
      assert.deepEqual(driver.events, ["acquire", "begin", "commit", "rollback", "release"]);
      return true;
    });
  } finally {
    await db.destroy();
  }
});

await test("explicit rollback after commit failure is not repeated on disposal", async () => {
  const { db, driver } = createDatabase();
  const commitError = new Error("commit failed");
  driver.failures.set("commit", commitError);
  try {
    {
      await using tx = await startTransaction(db);
      try {
        await tx.commit();
        assert.fail("commit must reject");
      } catch (error) {
        assert.equal(error, commitError);
        assert.equal(tx.transaction.isCommitted, false);
        assert.equal(tx.transaction.isRolledBack, false);
        await tx.rollback();
        assert.equal(tx.transaction.isRolledBack, true);
      }
    }
    assert.deepEqual(driver.events, ["acquire", "begin", "commit", "rollback", "release"]);
  } finally {
    await db.destroy();
  }
});

await test("commit and rollback failures produce SuppressedError with both original errors", async () => {
  const { db, driver } = createDatabase();
  const commitError = new Error("commit failed");
  const rollbackError = new Error("rollback failed");
  driver.failures.set("commit", commitError);
  driver.failures.set("rollback", rollbackError);
  try {
    await assert.rejects(async () => {
      await using tx = await startTransaction(db);
      await tx.commit();
    }, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "SuppressedError");
      assert.ok("error" in error);
      assert.ok("suppressed" in error);
      assert.equal(error.error, rollbackError);
      assert.equal(error.suppressed, commitError);
      assert.deepEqual(driver.events, ["acquire", "begin", "commit", "rollback", "release"]);
      return true;
    });
  } finally {
    await db.destroy();
  }
});

await test("body throw and rollback failure produce SuppressedError with both original errors", async () => {
  const { db, driver } = createDatabase();
  const bodyError = new Error("body failed");
  const rollbackError = new Error("rollback failed");
  driver.failures.set("rollback", rollbackError);
  try {
    await assert.rejects(async () => {
      await using tx = await startTransaction(db);
      assert.ok(tx.transaction);
      throw bodyError;
    }, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "SuppressedError");
      assert.ok("error" in error);
      assert.ok("suppressed" in error);
      assert.equal(error.error, rollbackError);
      assert.equal(error.suppressed, bodyError);
      assert.deepEqual(driver.events, ["acquire", "begin", "rollback", "release"]);
      return true;
    });
  } finally {
    await db.destroy();
  }
});

await test("database-aborted commit does not send a redundant rollback on disposal", async () => {
  const { db, driver } = createDatabase();
  const commitError = new AbortedTransactionError();
  driver.failures.set("commit", commitError);
  try {
    await assert.rejects(async () => {
      await using tx = await startTransaction(db);
      await tx.commit();
    }, (error: unknown) => {
      assert.equal(error, commitError);
      assert.deepEqual(driver.events, ["acquire", "begin", "commit", "release"]);
      return true;
    });
  } finally {
    await db.destroy();
  }
});

await test("transaction startup and rollback failures propagate", async () => {
  for (const failure of ["begin", "rollback"]) {
    const { db, driver } = createDatabase();
    driver.fail = failure;
    try {
      await assert.rejects(async () => {
        await using tx = await startTransaction(db);
        assert.ok(tx.transaction);
      }, { message: failure });
    } finally {
      await db.destroy();
    }
  }
});

await test("savepoint disposal rolls back without ending the outer transaction", async () => {
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
    assert.deepEqual(driver.events, [
      "acquire", "begin", "savepoint", "savepoint", "rollback-savepoint",
      "release-savepoint", "commit", "release",
    ]);
  } finally {
    await db.destroy();
  }
});

await test("explicit savepoint release and rollback prevent a second disposal command", async () => {
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
      assert.deepEqual(driver.events, [
        "acquire", "begin", "savepoint", `${action}-savepoint`, "rollback", "release",
      ]);
    } finally {
      await db.destroy();
    }
  }
});

await test("savepoint rolls back when the scope body throws", async () => {
  const { db, driver } = createDatabase();
  try {
    await assert.rejects(async () => {
      await using tx = await startTransaction(db);
      await using sp = await startSavePoint(tx.transaction, "point");
      assert.ok(sp.transaction);
      throw new Error("body");
    }, { message: "body" });
    assert.deepEqual(driver.events, [
      "acquire", "begin", "savepoint", "rollback-savepoint", "rollback", "release",
    ]);
  } finally {
    await db.destroy();
  }
});

await test("savepoint creation, release, and rollback failures propagate", async () => {
  for (const failure of ["savepoint", "release-savepoint", "rollback-savepoint"]) {
    const { db, driver } = createDatabase();
    try {
      await using tx = await startTransaction(db);
      driver.fail = failure;
      if (failure === "savepoint") {
        await assert.rejects(startSavePoint(tx.transaction, "point"), { message: failure });
      } else {
        const sp = await startSavePoint(tx.transaction, "point");
        const action = () => failure === "release-savepoint" ? sp.release() : sp.rollback();
        await assert.rejects(action(), { message: failure });
        driver.fail = undefined;
        await sp[Symbol.asyncDispose]();
        assert.equal(driver.events.filter((event) => event === "rollback-savepoint").length,
          failure === "rollback-savepoint" ? 2 : 1);
      }
    } finally {
      await db.destroy();
    }
  }
});

await test("startConnection forwards AbortableOperationOptions", async () => {
  const { db, driver } = createDatabase();
  const controller = new AbortController();
  try {
    {
      await using connection = await startConnection(db, { signal: controller.signal });
      assert.ok(connection.db);
    }
    assert.deepEqual(driver.connectionOptions, [
      { signal: controller.signal },
      { signal: controller.signal },
    ]);
  } finally {
    await db.destroy();
  }
});

await test("startTransaction accepts options object and builder callback", async () => {
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
    assert.deepEqual(driver.transactionSettings, [
      { isolationLevel: "serializable", accessMode: "read only" },
      { isolationLevel: undefined, accessMode: undefined },
      { isolationLevel: "repeatable read", accessMode: "read write" },
    ]);
  } finally {
    await db.destroy();
  }
});
