# ADR-0001: Lint と整形に Biome を使う

Status: Accepted / 2026-11-04

## 背景

設計書 (§8) で、ESLint か Biome の一方を選び、ADR に残すことになっている。

## 決定

Biome (`@biomejs/biome`) で Lint と整形を行う。設定は `biome.json`。

## 採らなかった案

- ESLint と Prettier: プラグイン (型を使うルールなど) は多いが、道具と設定が 2 つになり、依存も増える。今のコードの大きさでは、型を使うルールが要る場面がない。型を使うルールが要るようになったら見直す。

## 影響

- `pnpm lint` (`biome check .`) を CI で動かす。整形は `pnpm format`。
- `wrangler types` が作る `worker-configuration.d.ts` は、生成物なので対象から外す。
