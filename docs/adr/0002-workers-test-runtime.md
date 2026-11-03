# ADR-0002: テストを Workers の実行環境で動かす

Status: Accepted / 2026-11-04

## 背景

設計書 (§8) では `@cloudflare/vitest-pool-workers` か、そのときの Cloudflare 公式のテストのパッケージを使うことになっている。2026-11 に確かめると、`@cloudflare/vitest-pool-workers` は廃止され、`@cloudflare/vitest-plugin` に名前が変わっていた。

## 決定

`@cloudflare/vitest-plugin` の `cloudflareTest` を Vitest のプラグインにし、テストを workerd (Miniflare) で動かす。Worker は `cloudflare:workers` の `exports` から呼ぶ。

## 採らなかった案

- Node.js の上で Hono の `app.request()` だけを動かす: 速いが、本番 (workerd) と違う API で通ってしまう。

## 影響

- `wrangler.jsonc` の `compatibility_date` は、プラグインに付く workerd が対応する日付より新しくできない (新しくすると、テストの実行環境が起動しない)。wrangler とプラグインは、同じ頃の版をそろえて上げる。
