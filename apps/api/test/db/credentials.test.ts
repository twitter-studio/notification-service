import { env } from "cloudflare:workers";
import {
  createRelayCredential,
  findActiveRelayCredential,
  markRelayCredentialUsed,
  revokeRelayCredential,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, testDb, unique } from "./helpers";

const now = new Date("2026-11-04T00:00:00.000Z");

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
    ).rejects.toThrow();
  });

  it("期限を過ぎたものは使えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const hash = unique("hash");
    await createRelayCredential(db, {
      accountId: alice.accountId,
      secretHash: hash,
      expiresAt: new Date("2026-11-04T00:00:01.000Z"),
    });

    expect(await findActiveRelayCredential(db, hash, now)).toBeDefined();
    expect(
      await findActiveRelayCredential(db, hash, new Date("2026-11-04T00:00:01.000Z")),
    ).toBeUndefined();
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

  it("止めたアカウントの資格情報は使えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const hash = unique("hash");
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: hash });

    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(alice.accountId)
      .run();

    expect(await findActiveRelayCredential(db, hash, now)).toBeUndefined();
  });

  it("使った時刻を残す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const credential = await createRelayCredential(db, {
      accountId: alice.accountId,
      secretHash: unique("hash"),
    });

    await markRelayCredentialUsed(db, credential, now);

    const row = await env.DB.prepare("SELECT last_used_at FROM relay_credentials WHERE id = ?")
      .bind(credential)
      .first<{ last_used_at: string }>();
    expect(row?.last_used_at).toBe("2026-11-04T00:00:00.000Z");
  });
});
