import { env } from "cloudflare:workers";
import {
  createSession,
  deleteAccount,
  deleteExpiredAuthRecords,
  findActiveSession,
  isUniqueViolation,
  MAX_SESSIONS_PER_INSTALLATION,
  revokeInstallation,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, testDb, testHash, unique } from "./helpers";

const now = new Date("2026-11-04T00:00:00.000Z");
const later = new Date(now.getTime() + 60 * 60 * 1000);

function newChallenge() {
  return { nonce: unique("nonce"), expiresAt: later };
}

describe("セッション", () => {
  it("有効なインストールにだけ作れ、トークンのハッシュで探せる", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const tokenHash = testHash();

    expect(
      await createSession(
        db,
        {
          accountId: bob.accountId,
          installationId: alice.installationId,
          challenge: newChallenge(),
          session: { tokenHash: testHash(), expiresAt: later },
        },
        now,
      ),
    ).toBeUndefined();
    const id = await createSession(
      db,
      { ...alice, challenge: newChallenge(), session: { tokenHash, expiresAt: later } },
      now,
    );

    expect(id).toBeDefined();
    expect(await findActiveSession(db, tokenHash, now)).toEqual({
      sessionId: id,
      ...{ accountId: alice.accountId, installationId: alice.installationId },
    });
  });

  it("同じチャレンジでは、2 つ目のセッションを作れない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const challenge = newChallenge();
    await createSession(
      db,
      { ...alice, challenge, session: { tokenHash: testHash(), expiresAt: later } },
      now,
    );

    await expect(
      createSession(
        db,
        { ...alice, challenge, session: { tokenHash: testHash(), expiresAt: later } },
        now,
      ),
    ).rejects.toSatisfy((error) => isUniqueViolation(error, "used_challenges.nonce"));
  });

  it("1 つのインストールのセッションは、新しいものから上限の数だけ残し、古いものは消す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const bobHash = testHash();
    await createSession(
      db,
      { ...bob, challenge: newChallenge(), session: { tokenHash: bobHash, expiresAt: later } },
      now,
    );
    const hashes = Array.from({ length: MAX_SESSIONS_PER_INSTALLATION + 1 }, () => testHash());
    for (const [index, tokenHash] of hashes.entries()) {
      await createSession(
        db,
        { ...alice, challenge: newChallenge(), session: { tokenHash, expiresAt: later } },
        new Date(now.getTime() + index),
      );
    }

    const active = new Date(now.getTime() + hashes.length);
    const [oldest, ...newest] = hashes;
    expect(await findActiveSession(db, oldest ?? "", active)).toBeUndefined();
    for (const tokenHash of newest) {
      expect(await findActiveSession(db, tokenHash, active)).toBeDefined();
    }
    const rows = await env.DB.prepare(
      "SELECT count(*) AS count FROM sessions WHERE installation_id = ?",
    )
      .bind(alice.installationId)
      .first<{ count: number }>();
    expect(rows?.count).toBe(MAX_SESSIONS_PER_INSTALLATION);
    // ほかのインストールのセッションは消さない。
    expect(await findActiveSession(db, bobHash, active)).toBeDefined();
  });

  it("期限切れ、取り消したインストール、消したアカウントのセッションは使えず、取り消しと削除でセッションの行も消える", async () => {
    const db = testDb();
    const expired = await newAccount(db);
    const revoked = await newAccount(db);
    const deleted = await newAccount(db);
    const hashes = { expired: testHash(), revoked: testHash(), deleted: testHash() };
    await createSession(
      db,
      {
        ...expired,
        challenge: newChallenge(),
        session: { tokenHash: hashes.expired, expiresAt: now },
      },
      now,
    );
    await createSession(
      db,
      {
        ...revoked,
        challenge: newChallenge(),
        session: { tokenHash: hashes.revoked, expiresAt: later },
      },
      now,
    );
    await createSession(
      db,
      {
        ...deleted,
        challenge: newChallenge(),
        session: { tokenHash: hashes.deleted, expiresAt: later },
      },
      now,
    );

    await revokeInstallation(db, revoked);
    await deleteAccount(db, { accountId: deleted.accountId });

    expect(await findActiveSession(db, hashes.expired, now)).toBeUndefined();
    for (const account of [revoked, deleted]) {
      const row = await env.DB.prepare(
        "SELECT count(*) AS count FROM sessions WHERE installation_id = ?",
      )
        .bind(account.installationId)
        .first<{ count: number }>();
      expect(row?.count).toBe(0);
    }
  });

  it("期限を過ぎたチャレンジとセッションの記録を、表ごとに数えて消す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const past = new Date("2000-01-01T00:00:00.000Z");
    await createSession(
      db,
      {
        ...alice,
        challenge: { nonce: unique("nonce"), expiresAt: past },
        session: { tokenHash: testHash(), expiresAt: past },
      },
      past,
    );

    const result = await deleteExpiredAuthRecords(db, now);

    expect(result.challenges).toBeGreaterThanOrEqual(1);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
  });
});
