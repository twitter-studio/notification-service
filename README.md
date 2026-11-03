# notification-service

Twitter Studio の通知の中継 API。利用者の Worker から届いたイベントを、登録された端末へ APNs で送る (設計書: notification-docs の `docs/design/`)。

Hono と `@hono/zod-openapi` で Cloudflare Workers (`*.workers.dev`) に置き、D1 に登録を置く。今は土台と `GET /health`、エラーの応答 (problem+json) だけ。

## 構成

- `apps/api`: Worker (Hono)。`wrangler.jsonc` が設定。テストは `apps/api/test/`。
- `packages/db`: D1 のスキーマ (Drizzle)、migration (`migrations/`)、読み書きの関数。
- `packages/*`: 契約 (OpenAPI のスキーマ) などを足すときに置く。
- `docs/adr`: この API の ADR。

## 開発

Node.js と pnpm の版は `mise.toml` で固定している。

```sh
pnpm install --frozen-lockfile
pnpm lint        # Biome
pnpm typecheck   # wrangler types --check と tsc
pnpm test        # Vitest (workerd の上で動かす)
pnpm build       # wrangler deploy --dry-run (デプロイはしない)
pnpm --filter @notification-service/api dev   # 手元で起動 (http://localhost:8787/health)
```

`wrangler.jsonc` か `apps/api/.dev.vars.example` を変えたら、`pnpm --filter @notification-service/api types` で型を作り直す。手元の秘密は `apps/api/.dev.vars` (コミットしない) に置く。

本番やプレビューへのデプロイは、オーナーの承認を得てから行う。Cloudflare の資格情報や秘密は、このリポジトリに置かない。
