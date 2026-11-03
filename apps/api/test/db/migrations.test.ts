import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// 最初の migration (0000) の形で入れたデータが、後の migration を当てたあとも残ることを確かめる (設計書 §9 の migration upgrade)。
// 親の表を作り直す migration や、外部キーの CASCADE で、本番のデータが黙って消えるのを防ぐ (ADR-0004)。
// 表を作り直す migration は、末尾の PRAGMA defer_foreign_keys = off で外部キーの違反を数えなくするので、
// 当てたあとに PRAGMA foreign_key_check で、親のない子の行がないことも確かめる。
// ここで入れる SQL は 0000 の形に合わせて書き、後の migration に合わせて書き換えない。
it("データの入った D1 に後の migration を当てても、行が消えない", async () => {
  const [first] = env.TEST_MIGRATIONS;
  if (first === undefined) throw new Error("no migrations");
  const db = env.MIGRATION_DB;
  await applyD1Migrations(db, [first]);
  await db.batch([
    db.prepare("INSERT INTO notification_accounts (id) VALUES ('account')"),
    db.prepare(
      "INSERT INTO installations (id, account_id, public_key) VALUES ('installation', 'account', 'key')",
    ),
    db.prepare(
      "INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic, verified_at) VALUES ('device', 'installation', 'v1.c', 'f1.f', 'sandbox', 't', 1)",
    ),
    db.prepare(
      "INSERT INTO relay_credentials (id, account_id, secret_hash) VALUES ('credential', 'account', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')",
    ),
    db.prepare("INSERT INTO delivery_dedup (account_id, event_id) VALUES ('account', 'event')"),
  ]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  for (const [table, id] of [
    ["notification_accounts", "id = 'account'"],
    ["installations", "id = 'installation'"],
    ["devices", "id = 'device'"],
    ["relay_credentials", "id = 'credential'"],
    ["delivery_dedup", "event_id = 'event'"],
  ] as const) {
    const row = await db
      .prepare(`SELECT count(*) AS count FROM ${table} WHERE ${id}`)
      .first<{ count: number }>();
    expect(row?.count, table).toBe(1);
  }

  const violations = await db.prepare("PRAGMA foreign_key_check").all();
  expect(violations.results).toEqual([]);
});
