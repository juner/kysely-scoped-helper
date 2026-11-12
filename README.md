# kysely-scoped-helper

Kysely の接続・トランザクション・セーブポイントを `await using` で管理する、
型定義付きの ESM パッケージです。
[元の Gist](https://gist.github.com/juner/3bcf6f803cec61300f0db3d24042ea22) を基にしています。

## インストール

```sh
npm install kysely kysely-scoped-helper
```

Node.js 22.13 以上、Kysely `^0.29.8` が必要です。TypeScript 5.9 系で検証しており、
`compilerOptions.lib` に `ESNext.Disposable` と実行環境に対応する標準ライブラリを含めてください。
データベースの dialect とドライバーは利用側で設定します。

## 使用例

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

スコープは内側から後処理され、元の `db` 自体は破棄しません。
テーブル・カラム・クエリ結果の型は元の Kysely スキーマから引き継がれます。

| API | 明示的な操作 | `await using` のスコープ終了時 |
| --- | --- | --- |
| `startConnection(db)` | `release()` | 接続をプールに返却 |
| `startTransaction(db)` | `commit()` / `rollback()` | 未完了なら rollback |
| `startSavePoint(transaction, name)` | `release()` / `rollback()` | 未処理ならセーブポイントまで rollback |

- 接続は `connection.db`、トランザクションは `tx.transaction`、
  セーブポイント内の操作対象は `sp.transaction` です。
- 例外でスコープを抜けた場合も後処理が実行されます。取得や後処理の失敗は呼び出し側へ伝播します。
- `await using` を使わない場合は `try/finally` で
  `await resource[Symbol.asyncDispose]()` を呼び出してください。
- `startSavePoint` は Gist と同じ大文字小文字の API 名です。
  ネスト時には直前の `sp.transaction` を渡します。リテラルの重複名は型検査で拒否されます。
  動的に生成する名前の一意性は利用側で管理してください。
- セーブポイントには、利用する dialect / データベースの対応が必要です。
  rollback はセーブポイントを解放する操作ではありません。
- commit / rollback / release は必ず `await` し、同じリソースで競合する操作を並行実行しないでください。
  セーブポイントを外側から解放したり、親トランザクションを先に終了させたりしないでください。

## 開発・検証

```sh
npm ci
npm run lint
npm test
npm run build
npm pack --dry-run
```

ESLint の `strictTypeChecked` で unsafe な型操作や未処理の Promise などを検出します。
設定は `eslint.config.ts` に記述します。Node.js の対応範囲で読み込めるよう、
開発依存の `jiti` を使用し、設定自体も型検査・lint の対象に含めています。
TypeScript の strict モードと `@ts-expect-error` を使う型回帰テストで
スキーマ・セーブポイントの型を検証します。
実行時テストは Node.js 標準のテストランナーと Kysely のテスト用ドライバーを使い、
実データベースへの接続は不要です。実 DB 固有の挙動は利用側でも検証してください。
静的検査は実行時データの妥当性まで保証するものではありません。

`npm pack` / `npm publish` 時にビルドされ、JavaScript と型定義を含む `dist`、
README、ライセンスのみを配布します。公開は npm の権限を持つ利用者が行ってください。
