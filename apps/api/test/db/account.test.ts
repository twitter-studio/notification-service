import { env } from "cloudflare:workers";
import {
  ABANDONED_ACCOUNT_AFTER_MS,
  beginEvent,
  createDb,
  createSession,
  deleteAbandonedAccount,
  deleteAccount,
  disableDeviceByUser,
  findAbandonedAccounts,
  findActiveRelayCredential,
  listActiveDevices,
  revokeInstallation,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, registerToken, registerVerified, testDb, testHash, unique } from "./helpers";

async function count(table: string, column: string, value: string) {
  const row = await env.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ count: number }>();
  return row?.count;
}

describe("インストールの取り消しと、アカウントの削除", () => {
  it("インストールを取り消すと、端末の行も消え、トークンを手放す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const next = await newAccount(db);
    const token = unique("token");
    await registerVerified(db, alice, token);

    expect(await revokeInstallation(db, alice)).toBe(true);

    expect(await count("devices", "installation_id", alice.installationId)).toBe(0);
    expect((await registerToken(db, next, token)).kind).toBe("registered");
    expect(await revokeInstallation(db, alice)).toBe(false);
  });

  it("ほかのアカウントのインストールは取り消せない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    await registerVerified(db, alice, unique("token"));

    expect(
      await revokeInstallation(db, {
        accountId: bob.accountId,
        installationId: alice.installationId,
      }),
    ).toBe(false);
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("アカウントを消すと、子の行を消し、アカウントは deleted として残す。ほかのアカウントには触れない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceHash = testHash();
    await env.DB.prepare(
      "INSERT INTO relay_credentials (id, account_id, secret_hash) VALUES (?, ?, ?)",
    )
      .bind(unique("credential"), alice.accountId, aliceHash)
      .run();
    await registerVerified(db, alice, unique("token"));
    await registerVerified(db, bob, unique("token"));
    await beginEvent(db, { accountId: alice.accountId, eventKey: "e1" });

    expect(await deleteAccount(db, { accountId: alice.accountId })).toBe(true);

    expect(await count("installations", "account_id", alice.accountId)).toBe(0);
    expect(await count("devices", "installation_id", alice.installationId)).toBe(0);
    expect(await count("relay_credentials", "account_id", alice.accountId)).toBe(0);
    expect(await count("delivery_dedup", "account_id", alice.accountId)).toBe(0);
    expect(await findActiveRelayCredential(db, aliceHash)).toBeUndefined();
    const account = await env.DB.prepare(
      "SELECT state, deleted_at FROM notification_accounts WHERE id = ?",
    )
      .bind(alice.accountId)
      .first<{ state: string; deleted_at: number | null }>();
    expect(account?.state).toBe("deleted");
    expect(account?.deleted_at).not.toBeNull();
    expect(await listActiveDevices(db, bob.accountId)).toHaveLength(1);
    expect(await deleteAccount(db, { accountId: alice.accountId })).toBe(false);
  });
});

describe("使われなくなったアカウント", () => {
  const now = new Date("2026-11-04T00:00:00.000Z");
  const since = new Date(now.getTime() - ABANDONED_ACCOUNT_AFTER_MS);
  const longAgo = since.getTime() - 1;

  async function lastUsedAt(installationId: string) {
    const row = await env.DB.prepare("SELECT last_used_at FROM installations WHERE id = ?")
      .bind(installationId)
      .first<{ last_used_at: number }>();
    return row?.last_used_at;
  }

  async function setInstallationUsed(installationId: string, at: number) {
    await env.DB.prepare("UPDATE installations SET last_used_at = ? WHERE id = ?")
      .bind(at, installationId)
      .run();
  }

  async function stateOf(accountId: string) {
    const row = await env.DB.prepare("SELECT state FROM notification_accounts WHERE id = ?")
      .bind(accountId)
      .first<{ state: string }>();
    return row?.state;
  }

  it("セッションを作ると、インストールの最後に使った時刻を書く (1 日に 1 回まで)", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const session = (at: Date) =>
      createSession(
        db,
        {
          ...alice,
          challenge: { nonce: unique("nonce"), expiresAt: at },
          session: { tokenHash: testHash(), expiresAt: new Date(at.getTime() + 60_000) },
        },
        at,
      );
    const start = new Date("2026-12-01T00:00:00.000Z");
    await setInstallationUsed(alice.installationId, start.getTime() - 2 * 24 * 60 * 60 * 1000);

    await session(start);
    expect(await lastUsedAt(alice.installationId)).toBe(start.getTime());
    await session(new Date(start.getTime() + 60 * 60 * 1000));
    expect(await lastUsedAt(alice.installationId)).toBe(start.getTime());
  });

  it("アプリも中継の資格情報も期間のあいだ使われていないアカウントを消し、止めた端末と確かめた端末も消す", async () => {
    const db = testDb();
    const abandoned = await newAccount(db);
    const verifiedDevice = await registerVerified(db, abandoned, unique("token"));
    await disableDeviceByUser(db, { accountId: abandoned.accountId, deviceId: verifiedDevice });
    await setInstallationUsed(abandoned.installationId, longAgo);
    const neighbor = await newAccount(db);
    await registerVerified(db, neighbor, unique("token"));

    const found = await findAbandonedAccounts(db, { since }, 1000);
    expect(found.accountIds).toContain(abandoned.accountId);
    expect(found.accountIds).not.toContain(neighbor.accountId);
    expect(await deleteAbandonedAccount(db, { accountId: abandoned.accountId, since }, now)).toBe(
      true,
    );

    expect(await stateOf(abandoned.accountId)).toBe("deleted");
    for (const [table, column] of [
      ["installations", "account_id"],
      ["relay_credentials", "account_id"],
      ["sessions", "account_id"],
    ] as const) {
      expect(await count(table, column, abandoned.accountId), table).toBe(0);
    }
    expect(await count("devices", "id", verifiedDevice)).toBe(0);
    expect(await stateOf(neighbor.accountId)).toBe("active");
    expect(await listActiveDevices(db, neighbor.accountId)).toHaveLength(1);
  });

  it("アプリか中継の資格情報が期間のうちに使われたアカウントは、消さない", async () => {
    const db = testDb();
    const usedApp = await newAccount(db);
    const usedRelay = await newAccount(db);
    await setInstallationUsed(usedRelay.installationId, longAgo);
    await env.DB.prepare("UPDATE relay_credentials SET last_used_at = ? WHERE account_id = ?")
      .bind(since.getTime(), usedRelay.accountId)
      .run();

    for (const account of [usedApp, usedRelay]) {
      expect(await deleteAbandonedAccount(db, { accountId: account.accountId, since }, now)).toBe(
        false,
      );
      expect(await stateOf(account.accountId)).toBe("active");
      expect(await count("installations", "account_id", account.accountId)).toBe(1);
    }
  });

  it("探してから消すまでに、アプリがセッションを作ったら、消さない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    await setInstallationUsed(alice.installationId, longAgo);
    const racing = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await setInstallationUsed(alice.installationId, now.getTime());
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    expect(
      await deleteAbandonedAccount(createDb(racing), { accountId: alice.accountId, since }, now),
    ).toBe(false);

    expect(await stateOf(alice.accountId)).toBe("active");
    expect(await count("installations", "account_id", alice.accountId)).toBe(1);
    expect(await count("relay_credentials", "account_id", alice.accountId)).toBe(1);
  });
});
