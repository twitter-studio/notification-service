import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { unique } from "./helpers";

describe("D1 のスキーマ", () => {
  it("migration を当てると、設計書の 5 つの表がある", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual([
      "delivery_dedup",
      "devices",
      "installations",
      "notification_accounts",
      "relay_credentials",
    ]);
  });

  it("ないアカウントを指すインストールは、外部キーで拒む", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO installations (id, account_id, public_key) VALUES (?, ?, 'k')",
    ).bind(unique("installation"), unique("missing-account"));

    await expect(insert.run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it("アカウントの状態と、APNs の環境は、決めた値しか入らない", async () => {
    const account = unique("account");
    const installation = unique("installation");

    await expect(
      env.DB.prepare("INSERT INTO notification_accounts (id, state) VALUES (?, 'unknown')")
        .bind(account)
        .run(),
    ).rejects.toThrow(/CHECK/);

    await env.DB.prepare("INSERT INTO notification_accounts (id) VALUES (?)").bind(account).run();
    await env.DB.prepare(
      "INSERT INTO installations (id, account_id, public_key) VALUES (?, ?, 'k')",
    )
      .bind(installation, account)
      .run();
    const device = env.DB.prepare(
      "INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic) VALUES (?, ?, 'c', ?, 'staging', 't')",
    ).bind(unique("device"), installation, unique("fingerprint"));
    await expect(device.run()).rejects.toThrow(/CHECK/);
  });

  it("時刻の既定の値は、UTC の ISO 8601 で入る", async () => {
    const account = unique("account");
    await env.DB.prepare("INSERT INTO notification_accounts (id) VALUES (?)").bind(account).run();

    const row = await env.DB.prepare("SELECT created_at FROM notification_accounts WHERE id = ?")
      .bind(account)
      .first<{ created_at: string }>();

    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
