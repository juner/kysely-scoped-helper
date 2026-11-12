import type { ControlledTransaction, Kysely } from "kysely";
declare global {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface AsyncDisposable {
    }
}

export interface StartConnectionResult<DB> extends AsyncDisposable {
  readonly db: Kysely<DB>;
  release(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Holds a pooled connection until release() or the end of an await using scope.
 */
export async function startConnection<DB>(
  db: Kysely<DB>,
): Promise<StartConnectionResult<DB>> {
  const started = Promise.withResolvers<Kysely<DB>>();
  const ended = Promise.withResolvers<undefined>();
  const finished = db.connection().execute((connection) => {
    started.resolve(connection);
    return ended.promise;
  });
  // Acquisition can fail before the connection callback is entered.
  void finished.catch(started.reject);
  const connection = await started.promise;

  async function release(): Promise<void> {
    ended.resolve(undefined);
    await finished;
  }

  return {
    get db() {
      return connection;
    },
    release,
    [Symbol.asyncDispose]: release,
  };
}

export interface StartTransactionResult<DB> extends AsyncDisposable {
  readonly transaction: ControlledTransaction<DB>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Starts a controlled transaction and rolls it back on disposal unless finalized.
 */
export async function startTransaction<DB>(
  db: Kysely<DB>,
): Promise<StartTransactionResult<DB>> {
  const transaction = await db.startTransaction().execute();

  async function commit(): Promise<void> {
    await transaction.commit().execute();
  }

  async function rollback(): Promise<void> {
    await transaction.rollback().execute();
  }

  async function asyncDispose(): Promise<void> {
    if (transaction.isCommitted || transaction.isRolledBack) return;
    await rollback();
  }

  return {
    get transaction() {
      return transaction;
    },
    commit,
    rollback,
    [Symbol.asyncDispose]: asyncDispose,
  };
}

export interface StartSavePointResult<
  DB,
  SN extends string,
  S extends string[],
> extends AsyncDisposable {
  readonly transaction: ControlledTransaction<DB, [...S, SN]>;
  release(): Promise<void>;
  rollback(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Creates a savepoint and rolls back to it on disposal unless explicitly handled.
 */
export async function startSavePoint<
  DB,
  SN extends string,
  S extends string[] = [],
>(
  transaction: ControlledTransaction<DB, S>,
  savepointName: SN extends S[number] ? never : SN,
): Promise<StartSavePointResult<DB, SN, S>> {
  // Kysely compares the name to S rather than S[number] in its parameter type.
  const savepoint = await transaction
    .savepoint<SN>(savepointName as unknown as SN extends S ? never : SN)
    .execute();
  let handled = false;

  async function release(): Promise<void> {
    await savepoint.releaseSavepoint(savepointName).execute();
    handled = true;
  }

  async function rollback(): Promise<void> {
    await savepoint.rollbackToSavepoint(savepointName).execute();
    handled = true;
  }

  async function asyncDispose(): Promise<void> {
    if (handled || savepoint.isCommitted || savepoint.isRolledBack) return;
    await rollback();
  }

  return {
    get transaction() {
      return savepoint;
    },
    release,
    rollback,
    [Symbol.asyncDispose]: asyncDispose,
  };
}
