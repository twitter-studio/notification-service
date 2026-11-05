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

APNs の実装と遅延再送は [ADR-0011](docs/adr/0011-apns-delivery.md)、実機での接続確認は [APNS-001 の記録](docs/verification/2026-11-04-apns-sandbox.md) を参照。オーナーの承認で sandbox 検証用の運営 API・D1・再送 Queue を配置した。[初期配置の記録](docs/verification/2026-11-04-sandbox-deployment.md) に、対象、費用、確認結果と残る実機検証を記す。


## セキュリティと運用資料

報告方法は [SECURITY.md](SECURITY.md)、承認付き配置の定義と必要な設定は [ops/deployment.md](ops/deployment.md) を参照してください。追加の運営用資料へのリンクには、非公開リポジトリへの参照を含みます。公開コードから実サービスの利用登録やproduction運用を開始できるという意味ではありません。
