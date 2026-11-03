import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newAccount, testDb, testHash, unique } from "./helpers";

describe("D1 のスキーマ", () => {
  it("migration を当てると、設計書の 5 つの表と、登録の 2 つの表 (セッション、使ったチャレンジ)、端末の確かめの表、中継の 1 日の数の表がある", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual([
      "delivery_dedup",
      "device_verifications",
      "devices",
      "installations",
      "notification_accounts",
      "relay_credentials",
      "relay_usage",
      "sessions",
      "used_challenges",
    ]);
  });

  it("ないアカウントやインストールを指す行は、外部キーで拒む", async () => {
    const missing = unique("missing");
    const statements = [
      env.DB.prepare(
        "INSERT INTO installations (id, account_id, public_key) VALUES (?, ?, ?)",
      ).bind(unique("installation"), missing, unique("key")),
      env.DB.prepare(
        "INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic) VALUES (?, ?, 'v1.c', ?, 'sandbox', 't')",
      ).bind(unique("device"), missing, `f1.${unique("fingerprint")}`),
      env.DB.prepare(
        "INSERT INTO relay_credentials (id, account_id, secret_hash) VALUES (?, ?, ?)",
      ).bind(unique("credential"), missing, testHash()),
      env.DB.prepare("INSERT INTO delivery_dedup (account_id, event_key) VALUES (?, 'e')").bind(
        missing,
      ),
    ];

    for (const statement of statements) {
      await expect(statement.run()).rejects.toThrow(/FOREIGN KEY/);
    }
  });

  it("アカウントの状態、APNs の環境、端末の状態、確かめの状態は、決めた値しか入らない", async () => {
    const account = await newAccount(testDb());
    const insertDevice = (
      environment: string,
      state: string,
      ciphertext = "v1.c",
      fingerprint = `f1.${unique("fingerprint")}`,
    ) =>
      env.DB.prepare(
        "INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic, state) VALUES (?, ?, ?, ?, ?, 't', ?)",
      )
        .bind(unique("device"), account.installationId, ciphertext, fingerprint, environment, state)
        .run();

    await expect(
      env.DB.prepare("UPDATE notification_accounts SET state = 'unknown' WHERE id = ?")
        .bind(account.accountId)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare("UPDATE installations SET attestation_state = 'maybe' WHERE id = ?")
        .bind(account.installationId)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await expect(insertDevice("staging", "active")).rejects.toThrow(/CHECK/);
    await expect(insertDevice("sandbox", "paused")).rejects.toThrow(/CHECK/);
    // 平文のトークンや、版の付いていない指紋は置けない。
    await expect(insertDevice("sandbox", "active", "a".repeat(64))).rejects.toThrow(/CHECK/);
    await expect(insertDevice("sandbox", "active", "v1.c", "plain-fingerprint")).rejects.toThrow(
      /CHECK/,
    );
  });

  it("時刻の既定の値は、UNIX 時間のミリ秒の整数で入る", async () => {
    const before = Date.now();
    const account = unique("account");
    await env.DB.prepare("INSERT INTO notification_accounts (id) VALUES (?)").bind(account).run();

    const row = await env.DB.prepare("SELECT created_at FROM notification_accounts WHERE id = ?")
      .bind(account)
      .first<{ created_at: number }>();

    expect(Number.isInteger(row?.created_at)).toBe(true);
    expect(row?.created_at).toBeGreaterThanOrEqual(before - 1000);
    expect(row?.created_at).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
