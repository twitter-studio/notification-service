import { env } from "cloudflare:workers";
import {
  createRelayCredential,
  deleteRevokedRelayCredentials,
  findActiveRelayCredential,
  isUniqueViolation,
  LAST_USED_RESOLUTION_MS,
  MAX_RELAY_CREDENTIALS_PER_HOUR,
  markRelayCredentialUsed,
  revokeInstallation,
  revokeRelayCredential,
  rotateRelayCredential,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { consumedChallenge, newAccount, testDb, testHash, unique } from "./helpers";

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
    const aliceHash = testHash();
    const bobHash = testHash();
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: aliceHash });
    await createRelayCredential(db, { accountId: bob.accountId, secretHash: bobHash });

    expect((await findActiveRelayCredential(db, aliceHash, now))?.accountId).toBe(alice.accountId);
    expect((await findActiveRelayCredential(db, bobHash, now))?.accountId).toBe(bob.accountId);
    expect(await findActiveRelayCredential(db, unique("unknown"), now)).toBeUndefined();
  });

  it("同じハッシュは 2 つ置けない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const hash = testHash();
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: hash });

    await expect(
      createRelayCredential(db, { accountId: alice.accountId, secretHash: hash }),
    ).rejects.toSatisfy((error) => isUniqueViolation(error, "relay_credentials.secret_hash"));
  });

  it("期限を過ぎたものは使えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const hash = testHash();
    const expiresAt = new Date(now.getTime() + 1);
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: hash, expiresAt });

    expect(await findActiveRelayCredential(db, hash, now)).toBeDefined();
    expect(await findActiveRelayCredential(db, hash, expiresAt)).toBeUndefined();
  });

  it("取り消せるのは自分のアカウントのものだけで、取り消すと使えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const hash = testHash();
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
      const hash = testHash();
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
      secretHash: testHash(),
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

  it("入れ替えると、そのアカウントの使える資格情報をすべて取り消し、新しいものだけを残す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const old = [testHash(), testHash()];
    for (const secretHash of old) {
      await createRelayCredential(db, { accountId: alice.accountId, secretHash });
    }
    const bobHash = testHash();
    await createRelayCredential(db, { accountId: bob.accountId, secretHash: bobHash });
    const newHash = testHash();

    const rotation = await rotateRelayCredential(
      db,
      { ...alice, challenge: consumedChallenge(), secretHash: newHash },
      now,
    );

    expect(rotation.kind).toBe("rotated");
    expect(await findActiveRelayCredential(db, newHash, now)).toEqual({
      id: rotation.kind === "rotated" ? rotation.credentialId : undefined,
      accountId: alice.accountId,
    });
    for (const secretHash of old) {
      expect(await findActiveRelayCredential(db, secretHash, now)).toBeUndefined();
    }
    expect((await findActiveRelayCredential(db, bobHash, now))?.accountId).toBe(bob.accountId);
  });

  it("ほかのアカウントのインストール、止めたアカウント、取り消したインストールでは、何も変えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceHash = testHash();
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: aliceHash });
    const rotateAlice = (installationId: string) =>
      rotateRelayCredential(
        db,
        {
          accountId: alice.accountId,
          installationId,
          challenge: consumedChallenge(),
          secretHash: testHash(),
        },
        now,
      );

    expect(await rotateAlice(bob.installationId)).toEqual({ kind: "rejected" });
    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(alice.accountId)
      .run();
    expect(await rotateAlice(alice.installationId)).toEqual({ kind: "rejected" });
    await env.DB.prepare("UPDATE notification_accounts SET state = 'active' WHERE id = ?")
      .bind(alice.accountId)
      .run();
    expect(await findActiveRelayCredential(db, aliceHash, now)).toBeDefined();

    await revokeInstallation(db, alice);
    expect(await rotateAlice(alice.installationId)).toEqual({ kind: "rejected" });
    const rows = await env.DB.prepare(
      "SELECT count(*) AS count FROM relay_credentials WHERE account_id = ?",
    )
      .bind(alice.accountId)
      .first<{ count: number }>();
    // 登録で作ったものと、上で置いたものの 2 つのまま (新しく置いていない)。
    expect(rows?.count).toBe(2);
  });

  it("1 時間に作れる数を超えると、何も変えず、前の資格情報を残す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    // 登録で 1 つ作ってある。
    for (let index = 1; index < MAX_RELAY_CREDENTIALS_PER_HOUR; index++) {
      const rotation = await rotateRelayCredential(
        db,
        { ...alice, challenge: consumedChallenge(), secretHash: testHash() },
        new Date(),
      );
      expect(rotation.kind, String(index)).toBe("rotated");
    }
    const lastHash = testHash();
    await env.DB.prepare(
      "UPDATE relay_credentials SET secret_hash = ? WHERE account_id = ? AND revoked_at IS NULL",
    )
      .bind(lastHash, alice.accountId)
      .run();

    expect(
      await rotateRelayCredential(
        db,
        { ...alice, challenge: consumedChallenge(), secretHash: testHash() },
        new Date(),
      ),
    ).toEqual({ kind: "rejected" });
    expect(await findActiveRelayCredential(db, lastHash)).toBeDefined();
    // 1 時間たてば、また作れる。
    expect(
      (
        await rotateRelayCredential(
          db,
          { ...alice, challenge: consumedChallenge(), secretHash: testHash() },
          new Date(Date.now() + 60 * 60 * 1000 + 1),
        )
      ).kind,
    ).toBe("rotated");
  });

  it("インストールを取り消すと、そのアカウントの資格情報も取り消し、使えなくなる", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceHash = testHash();
    const bobHash = testHash();
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: aliceHash });
    await createRelayCredential(db, { accountId: bob.accountId, secretHash: bobHash });

    await revokeInstallation(db, alice, now);

    expect(await findActiveRelayCredential(db, aliceHash, now)).toBeUndefined();
    const row = await env.DB.prepare(
      "SELECT revoked_at FROM relay_credentials WHERE secret_hash = ?",
    )
      .bind(aliceHash)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBe(now.getTime());
    expect((await findActiveRelayCredential(db, bobHash, now))?.accountId).toBe(bob.accountId);
  });

  it("取り消していないインストールのないアカウントの資格情報は、取り消していなくても使えない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const hash = testHash();
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: hash });
    await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
      .bind(now.getTime(), alice.installationId)
      .run();

    expect(await findActiveRelayCredential(db, hash, now)).toBeUndefined();
  });

  it("SHA-256 の Base64URL の形 (43 文字) でないもの、平文のトークンは置けない", async () => {
    const db = testDb();
    const alice = await newAccount(db);

    for (const value of [`tsr_${"A".repeat(43)}`, `${"A".repeat(42)}=`, `${"A".repeat(42)}+`]) {
      await expect(
        env.DB.prepare(
          "INSERT INTO relay_credentials (id, account_id, secret_hash) VALUES (?, ?, ?)",
        )
          .bind(unique("credential"), alice.accountId, value)
          .run(),
        value,
      ).rejects.toThrow(/CHECK/);
    }
  });

  it("取り消してから期間を過ぎた資格情報だけを消す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const old = testHash();
    const recent = testHash();
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: old });
    await createRelayCredential(db, { accountId: alice.accountId, secretHash: recent });
    const before = new Date("2001-01-01T00:00:00.000Z");
    await env.DB.batch([
      env.DB.prepare("UPDATE relay_credentials SET revoked_at = ? WHERE secret_hash = ?").bind(
        before.getTime() - 1,
        old,
      ),
      env.DB.prepare("UPDATE relay_credentials SET revoked_at = ? WHERE secret_hash = ?").bind(
        before.getTime(),
        recent,
      ),
    ]);

    await deleteRevokedRelayCredentials(db, before);

    const rows = await env.DB.prepare(
      "SELECT secret_hash FROM relay_credentials WHERE secret_hash IN (?, ?)",
    )
      .bind(old, recent)
      .all<{ secret_hash: string }>();
    expect(rows.results.map((row) => row.secret_hash)).toEqual([recent]);
  });

  it("同じチャレンジでは 2 回入れ替えられない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const challenge = consumedChallenge();
    await rotateRelayCredential(db, { ...alice, challenge, secretHash: testHash() }, now);

    await expect(
      rotateRelayCredential(db, { ...alice, challenge, secretHash: testHash() }, now),
    ).rejects.toSatisfy((error) => isUniqueViolation(error, "used_challenges.nonce"));
  });
});
