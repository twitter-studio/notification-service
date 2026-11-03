# ADR-0003: Node.js、pnpm の入れ方、Workers の互換の設定

Status: Accepted / 2026-11-04

## 背景

設計書 (§8) は「今のサポートされている LTS の Node.js」と「Corepack で入れる pnpm」を求めている。2026-11 に確かめると、Node.js 26 が Active LTS (26.13.0、2026-10-28) になり、24 は Maintenance LTS だった。

## 決定

- Node.js は 26 (Active LTS) を使う。手元は `mise.toml`、CI は `actions/setup-node` の `node-version` で固定し、2 か所をそろえる (どちらも Dependabot では上がらないので、手で上げる)。
- pnpm は、手元は mise、CI は `pnpm/action-setup` (`package.json` の `packageManager` を読む) で入れる。
- `wrangler.jsonc` の `compatibility_date` が 2026-08-04 より後なので、`nodejs_compat` が既定で有効になる。コードは Node.js の API に頼らず、Web の標準の API (Web Crypto など) を使う。

## 採らなかった案

- Corepack で pnpm を入れる: Node.js 25 から、Corepack は Node.js に付いてこなくなった。別に入れることになり、mise と役割が重なる。
- Node.js 24: 設計書の「今の LTS」に合わない。

## 影響

- Node.js の版を上げるときは、`mise.toml` と `.github/workflows/ci.yml` をそろえて上げる。
