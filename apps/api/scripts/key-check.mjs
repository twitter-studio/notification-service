// 鍵の確かめの値を作る (ADR-0005)。鍵 (32 バイトの Base64) を標準入力から読み、確かめの値だけを出す。鍵そのものは出さない。
// 使い方: openssl rand -base64 32 > key.txt && node apps/api/scripts/key-check.mjs < key.txt
// src/security/device-token.ts の keyCheckValue と同じ計算。
import { createHash } from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const key = Buffer.from(Buffer.concat(chunks).toString("utf8").trim(), "base64");
if (key.length !== 32) {
  console.error("key must be 32 bytes of Base64");
  process.exit(1);
}
const digest = createHash("sha256").update("twitter-studio/key-check/v1").update(key).digest("hex");
console.log(digest.slice(0, 16));
