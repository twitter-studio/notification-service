import { env } from "cloudflare:workers";
import {
  acceptEventOnce,
  deleteAccount,
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
    await acceptEventOnce(db, { accountId: alice.accountId, eventId: "e1" });

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
