# kysely-scoped-helper

A typed ESM package for managing Kysely connections, transactions, and savepoints with `await using` (Explicit Resource Management).
Based on the [original Gist](https://gist.github.com/juner/3bcf6f803cec61300f0db3d24042ea22).

## Installation

```sh
npm install kysely kysely-scoped-helper
```

Requires Node.js 22.13 or later and Kysely `^0.29.8`. Verified with TypeScript 5.9; include `ESNext.Disposable` alongside the standard library for your target runtime in `compilerOptions.lib`.
Database dialects and drivers are configured by the consumer.

## Usage

```ts
import type { Kysely } from "kysely";
import {
  startConnection,
  startTransaction,
  startSavePoint,
} from "kysely-scoped-helper";

interface Database {
  person: { id: number; name: string };
}

export async function insertPerson(db: Kysely<Database>): Promise<void> {
  await using connection = await startConnection(db);
  await using tx = await startTransaction(connection.db);

  {
    await using sp = await startSavePoint(tx.transaction, "insert_person");
    await sp.transaction
      .insertInto("person")
      .values({ id: 1, name: "Alice" })
      .execute();
    await sp.release();
  }

  await tx.commit();
}
```

Scopes are cleaned up from the inside out, and the original `db` instance itself is not destroyed.
Table, column, and query result types are preserved from the original Kysely schema.

| API | Explicit Actions | On `await using` Scope Exit |
| --- | --- | --- |
| `startConnection(db, options?)` | `release()` | Returns the connection to the pool |
| `startTransaction(db, options?)` | `commit()` / `rollback()` | Rolls back if not finalized |
| `startSavePoint(transaction, name)` | `release()` / `rollback()` | Rolls back to the savepoint if not handled |

- Access the scoped instances via `connection.db` for connections, `tx.transaction` for transactions, and `sp.transaction` for operations within a savepoint.
- `options` in `startConnection` accepts `{ signal?: AbortSignal }` (`AbortableOperationOptions`).
- `options` in `startTransaction` accepts either a `{ isolationLevel?, accessMode? }` object or a configuration callback `(builder) => builder` receiving `ControlledTransactionBuilder`.
- Cleanup runs even when exiting a scope due to an exception. Acquisition and cleanup failures propagate to the caller.
- If you are not using `await using`, call `await resource[Symbol.asyncDispose]()` inside a `try/finally` block.
- `startSavePoint` keeps the same casing as the original Gist API. When nesting savepoints, pass the preceding `sp.transaction`. Duplicate literal savepoint names are rejected at compile time; uniqueness of dynamically generated names must be managed by the caller.
- Savepoints require support from your database dialect and engine. Rolling back to a savepoint does not release it.
- Always `await` calls to `commit`, `rollback`, and `release`, and do not run conflicting operations concurrently on the same resource. Do not release an outer savepoint before an inner one, or finalize a parent transaction before its savepoints.

## Development & Verification

```sh
npm ci
npm run lint
npm test
npm run test:coverage
npm run build
npm pack --dry-run
```

ESLint with `strictTypeChecked` detects unsafe type operations, floating Promises, and other issues.
Configuration is written in `eslint.config.ts`, loaded via `jiti` (a dev dependency) across supported Node.js versions, and is itself type-checked and linted.
Type regression tests using TypeScript's `strict` mode and `@ts-expect-error` verify schema and savepoint types.
Runtime tests use Vitest and Kysely's `DummyDriver`, requiring no live database connection. Verify database-specific behavior in your own environment. Static type checks do not guarantee runtime data validity.

### Coverage

`npm run test:coverage` (also invoked by `npm test`) runs Vitest with `@vitest/coverage-v8`, enforcing 100% statement, branch, function, and line coverage against `src/**/*.ts`.
It prints a summary table in the terminal and writes Cobertura (`cobertura-coverage.xml`) and JSON (`coverage-final.json`, `coverage-summary.json`) reports under `TestResults/coverage/`.

Type-level regression tests (`npm run test:types`) are not part of runtime coverage, so run `npm test` to verify both.
`TestResults/` is ignored by Git and excluded from the published npm package.

Running `npm pack` / `npm publish` builds the project and distributes only `dist` (JavaScript and `.d.ts` files), `README.md`, and `LICENSE`. Publishing should be performed by a maintainer with npm publish permissions.
