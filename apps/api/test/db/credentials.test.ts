import { env } from "cloudflare:workers";
import {
  createRelayCredential,
  findActiveRelayCredential,
  isUniqueViolation,
  LAST_USED_RESOLUTION_MS,
  markRelayCredentialUsed,
  revokeRelayCredential,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, testDb, unique } from "./helpers";

const now = new Date("2026-11-04T00:00:00.000Z");

async function lastUsedAt(credentialId: string) {
  const row = await env.DB.prepare("SELECT last_used_at FROM relay_credentials WHERE id = ?")
    .bind(credentialId)
    .first<{ last_used_at: number | null }>();
  return row?.last_used_at;
}

describe("中継の資格情報", () => {
  it("ハッシュから、その資格情報のアカウントだけが決まる", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceHash = unique("hash");
    const bobHash = unique("hash");
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: aliceHash });
    await createRelayCredential(db, { accountId: bob.accountId, secretHash: bobHash });

    expect((await findActiveRelayCredential(db, aliceHash, now))?.accountId).toBe(alice.accountId);
    expect((await findActiveRelayCredential(db, bobHash, now))?.accountId).toBe(bob.accountId);
    expect(await findActiveRelayCredential(db, unique("unknown"), now)).toBeUndefined();
  });

  it("同じハッシュは 2 つ置けない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const hash = unique("hash");
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: hash });

    await expect(
      createRelayCredential(db, { accountId: alice.accountId, secretHash: hash }),
    ).rejects.toSatisfy((error) => isUniqueViolation(error, "relay_credentials.secret_hash"));
  });

  it("期限を過ぎたものは使えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const hash = unique("hash");
    const expiresAt = new Date(now.getTime() + 1);
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: hash, expiresAt });

    expect(await findActiveRelayCredential(db, hash, now)).toBeDefined();
    expect(await findActiveRelayCredential(db, hash, expiresAt)).toBeUndefined();
  });

  it("取り消せるのは自分のアカウントのものだけで、取り消すと使えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const hash = unique("hash");
    const credential = await createRelayCredential(db, {
      accountId: alice.accountId,
      secretHash: hash,
    });

    expect(
      await revokeRelayCredential(db, { accountId: bob.accountId, credentialId: credential }, now),
    ).toBe(false);
    expect(await findActiveRelayCredential(db, hash, now)).toBeDefined();

    expect(
      await revokeRelayCredential(
        db,
        { accountId: alice.accountId, credentialId: credential },
        now,
      ),
    ).toBe(true);
    expect(await findActiveRelayCredential(db, hash, now)).toBeUndefined();
    expect(
      await revokeRelayCredential(
        db,
        { accountId: alice.accountId, credentialId: credential },
        now,
      ),
    ).toBe(false);
  });

  it("止めたアカウントと、消したアカウントの資格情報は使えない", async () => {
    const db = testDb();
    for (const state of ["disabled", "deleted"]) {
      const account = await newAccount(db);
      const hash = unique("hash");
      await createRelayCredential(db, { accountId: account.accountId, secretHash: hash });

      await env.DB.prepare("UPDATE notification_accounts SET state = ? WHERE id = ?")
        .bind(state, account.accountId)
        .run();

      expect(await findActiveRelayCredential(db, hash, now), state).toBeUndefined();
    }
  });

  it("使った時刻は、自分のアカウントの、取り消していないものにだけ、間をあけて残す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const credential = await createRelayCredential(db, {
      accountId: alice.accountId,
      secretHash: unique("hash"),
    });

    await markRelayCredentialUsed(db, { accountId: bob.accountId, credentialId: credential }, now);
    expect(await lastUsedAt(credential)).toBeNull();

    await markRelayCredentialUsed(
      db,
      { accountId: alice.accountId, credentialId: credential },
      now,
    );
    expect(await lastUsedAt(credential)).toBe(now.getTime());

    const soon = new Date(now.getTime() + LAST_USED_RESOLUTION_MS - 1);
    await markRelayCredentialUsed(
      db,
      { accountId: alice.accountId, credentialId: credential },
      soon,
    );
    expect(await lastUsedAt(credential)).toBe(now.getTime());

    await revokeRelayCredential(db, { accountId: alice.accountId, credentialId: credential }, now);
    const later = new Date(now.getTime() + LAST_USED_RESOLUTION_MS + 1);
    await markRelayCredentialUsed(
      db,
      { accountId: alice.accountId, credentialId: credential },
      later,
    );
    expect(await lastUsedAt(credential)).toBe(now.getTime());
  });
});
