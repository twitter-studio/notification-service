import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deviceIdOf, newAccount, registerToken, testDb, unique } from "./helpers";

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

  it("ないアカウントやインストールを指す行は、外部キーで拒む", async () => {
    const missing = unique("missing");
    const statements = [
      env.DB.prepare(
        "INSERT INTO installations (id, account_id, public_key) VALUES (?, ?, ?)",
      ).bind(unique("installation"), missing, unique("key")),
      env.DB.prepare(
        "INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic) VALUES (?, ?, 'c', ?, 'sandbox', 't')",
      ).bind(unique("device"), missing, unique("fingerprint")),
      env.DB.prepare(
        "INSERT INTO relay_credentials (id, account_id, secret_hash) VALUES (?, ?, ?)",
      ).bind(unique("credential"), missing, unique("hash")),
      env.DB.prepare("INSERT INTO delivery_dedup (account_id, event_id) VALUES (?, 'e')").bind(
        missing,
      ),
    ];

    for (const statement of statements) {
      await expect(statement.run()).rejects.toThrow(/FOREIGN KEY/);
    }
  });

  it("アカウントの状態、APNs の環境、端末の状態は、決めた値しか入らない", async () => {
    const account = await newAccount(testDb());

    await expect(
      env.DB.prepare("UPDATE notification_accounts SET state = 'unknown' WHERE id = ?")
        .bind(account.accountId)
        .run(),
    ).rejects.toThrow(/CHECK/);
    for (const [column, value] of [
      ["apns_environment", "staging"],
      ["state", "paused"],
    ] as const) {
      const insert = env.DB.prepare(
        `INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic, ${column === "state" ? "state" : "topic"}) VALUES (?, ?, 'c', ?, ?, 't', ?)`,
      ).bind(
        unique("device"),
        account.installationId,
        unique("fingerprint"),
        column === "apns_environment" ? value : "sandbox",
        column === "state" ? value : "t",
      );
      await expect(insert.run()).rejects.toThrow(/CHECK/);
    }
  });

  it("時刻の既定の値は、UNIX 時間のミリ秒の整数で入る", async () => {
    const before = Date.now();
    const account = await newAccount(testDb());

    const row = await env.DB.prepare("SELECT created_at FROM notification_accounts WHERE id = ?")
      .bind(account.accountId)
      .first<{ created_at: number }>();

    expect(Number.isInteger(row?.created_at)).toBe(true);
    expect(row?.created_at).toBeGreaterThanOrEqual(before - 1000);
    expect(row?.created_at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("アカウントを消すと、インストール、端末、資格情報、受け付けの記録も消える", async () => {
    const db = testDb();
    const account = await newAccount(db);
    deviceIdOf(await registerToken(db, account, unique("token")));
    await env.DB.prepare("INSERT INTO delivery_dedup (account_id, event_id) VALUES (?, 'e')")
      .bind(account.accountId)
      .run();

    await env.DB.prepare("DELETE FROM notification_accounts WHERE id = ?")
      .bind(account.accountId)
      .run();

    for (const table of ["installations", "relay_credentials", "delivery_dedup"]) {
      const row = await env.DB.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE account_id = ?`,
      )
        .bind(account.accountId)
        .first<{ count: number }>();
      expect(row?.count, table).toBe(0);
    }
    const devices = await env.DB.prepare(
      "SELECT count(*) AS count FROM devices WHERE installation_id = ?",
    )
      .bind(account.installationId)
      .first<{ count: number }>();
    expect(devices?.count).toBe(0);
  });
});
