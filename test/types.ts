import type { ControlledTransaction, Kysely } from "kysely";
import {
  startConnection,
  startSavePoint,
  startTransaction,
  type StartConnectionResult,
  type StartSavePointResult,
  type StartTransactionResult,
} from "../src/index.js";

interface Database {
  person: { id: number; name: string };
}

function expectType<T>(value: T): T {
  return value;
}

export async function checkTypes(db: Kysely<Database>): Promise<void> {
  await using connection = await startConnection(db);
  expectType<StartConnectionResult<Database>>(connection);
  expectType<Kysely<Database>>(connection.db);
  const person = await connection.db.selectFrom("person").selectAll().executeTakeFirstOrThrow();
  expectType<number>(person.id);
  expectType<string>(person.name);
  // @ts-expect-error Unknown tables must not be accepted.
  connection.db.selectFrom("missing");
  // @ts-expect-error Unknown columns must not be accepted.
  connection.db.selectFrom("person").select("missing");
  // @ts-expect-error Query results must retain their column types.
  expectType<string>(person.id);

  await using tx = await startTransaction(connection.db);
  expectType<StartTransactionResult<Database>>(tx);
  expectType<ControlledTransaction<Database>>(tx.transaction);
  // @ts-expect-error Transaction queries must retain the schema.
  tx.transaction.selectFrom("missing");

  await using outer = await startSavePoint(tx.transaction, "outer");
  expectType<StartSavePointResult<Database, "outer", []>>(outer);
  expectType<ControlledTransaction<Database, ["outer"]>>(outer.transaction);
  await using inner = await startSavePoint(outer.transaction, "inner");
  expectType<ControlledTransaction<Database, ["outer", "inner"]>>(inner.transaction);
  const row = await inner.transaction.selectFrom("person").select("id").executeTakeFirstOrThrow();
  expectType<number>(row.id);
  // @ts-expect-error Savepoint queries must retain the schema.
  inner.transaction.selectFrom("person").select("missing");
  // @ts-expect-error Only known savepoints may be released.
  inner.transaction.releaseSavepoint("missing");
  // @ts-expect-error Duplicate savepoint names must be rejected.
  await startSavePoint(outer.transaction, "outer");
  // @ts-expect-error Earlier savepoint names must also be rejected.
  await startSavePoint(inner.transaction, "outer");
  // @ts-expect-error Names must be strings.
  await startSavePoint(tx.transaction, 1);
  // @ts-expect-error Savepoints require a controlled transaction.
  await startSavePoint(db, "point");
}
