import { and, eq, exists, gt, isNull } from "drizzle-orm";
import type { Db } from "./db";
import type { ConsumedChallenge, NewAttestation, NewSession } from "./enroll";
import { installationAttestations, installations, notificationAccounts, sessions } from "./schema";

/** 有効なインストール (取り消しておらず、アカウントが有効) を ID で探す。セッションを作り直すときの署名の確かめに使う。 */
export async function findActiveInstallation(db: Db, installationId: string) {
  const rows = await db
    .select({
      accountId: installations.accountId,
      publicKey: installations.publicKey,
      attestation: installationAttestations,
    })
    .from(installations)
    .leftJoin(
      installationAttestations,
      eq(installations.id, installationAttestations.installationId),
    )
    .innerJoin(notificationAccounts, eq(installations.accountId, notificationAccounts.id))
    .where(
      and(
        eq(installations.id, installationId),
        isNull(installations.revokedAt),
        eq(notificationAccounts.state, "active"),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 登録済みの鍵からアカウントを決める読み。取り消し済みの鍵はenrollInstallation側で拒む。 */
export async function findInstallationByPublicKey(db: Db, publicKey: string) {
  const [row] = await db
    .select({ id: installations.id })
    .from(installations)
    .where(eq(installations.publicKey, publicKey))
    .limit(1);
  return row === undefined
    ? undefined
    : { id: row.id, ...(await findActiveInstallation(db, row.id)) };
}

export type SessionAttestation =
  | { kind: "none" }
  | { kind: "initial"; value: NewAttestation; previousKeyId?: string }
  | { kind: "assertion"; keyId: string; previousCounter: number; counter: number };

/** 1 つのインストールが同時に持てるセッションの数。作るときに、これを超える古いものを消す (DB の行を増やし続けさせない)。 */
export const MAX_SESSIONS_PER_INSTALLATION = 5;

/**
 * セッションを作る。チャレンジを使ったものとして記録し (同じチャレンジの 2 回目は UNIQUE で失敗する)、
 * インストールがそのアカウントの有効なものなら、セッションを置く (1 つのバッチ)。作れたらセッションの ID。
 * 新しく置くものを含めて `MAX_SESSIONS_PER_INSTALLATION` 個になるよう、そのインストールの古いセッション
 * (期限切れ、取り消し済みを含む) を消す。
 */
export async function createSession(
  db: Db,
  input: {
    accountId: string;
    installationId: string;
    challenge: ConsumedChallenge;
    session: NewSession;
    attestation?: SessionAttestation;
  },
  now = new Date(),
): Promise<string | undefined> {
  const id = crypto.randomUUID();
  const proof = input.attestation ?? { kind: "none" };
  const active = `EXISTS (SELECT 1 FROM installations i JOIN notification_accounts a ON a.id = i.account_id
    WHERE i.id = ?1 AND i.account_id = ?2 AND i.revoked_at IS NULL AND a.state = 'active')`;
  const authorize: ReturnType<Db["$client"]["prepare"]>[] = [];
  if (proof.kind === "initial") {
    const v = proof.value;
    if (proof.previousKeyId !== undefined) {
      authorize.push(
        db.$client
          .prepare(`UPDATE installation_attestations
        SET key_id = ?3, public_key = ?4, counter = 0, app_id = ?5, environment = ?6, receipt_ciphertext = ?7
        WHERE installation_id = ?1 AND key_id = ?8 AND ${active}`)
          .bind(
            input.installationId,
            input.accountId,
            v.keyId,
            v.publicKey,
            v.appId,
            v.environment,
            v.receiptCiphertext,
            proof.previousKeyId,
          ),
      );
    } else
      authorize.push(
        db.$client
          .prepare(`INSERT INTO installation_attestations
      (installation_id, key_id, public_key, counter, app_id, environment, receipt_ciphertext)
      SELECT ?1, ?3, ?4, 0, ?5, ?6, ?7 WHERE ${active}
        AND NOT EXISTS (SELECT 1 FROM installation_attestations WHERE installation_id = ?1)
      ON CONFLICT(installation_id) DO NOTHING`)
          .bind(
            input.installationId,
            input.accountId,
            v.keyId,
            v.publicKey,
            v.appId,
            v.environment,
            v.receiptCiphertext,
          ),
      );
    authorize.push(
      db.$client
        .prepare(`UPDATE installations SET attestation_state = 'verified'
      WHERE id = ?1 AND account_id = ?2 AND changes() = 1`)
        .bind(input.installationId, input.accountId),
    );
  } else if (proof.kind === "assertion") {
    authorize.push(
      db.$client
        .prepare(`UPDATE installation_attestations SET counter = ?5
      WHERE installation_id = ?1 AND key_id = ?3 AND counter = ?4 AND counter < ?5 AND ${active}`)
        .bind(
          input.installationId,
          input.accountId,
          proof.keyId,
          proof.previousCounter,
          proof.counter,
        ),
    );
  } else {
    authorize.push(
      db.$client
        .prepare(`UPDATE installations SET last_used_at = last_used_at
      WHERE id = ?1 AND account_id = ?2 AND attestation_state = 'pending' AND ${active}
        AND NOT EXISTS (SELECT 1 FROM installation_attestations WHERE installation_id = ?1)`)
        .bind(input.installationId, input.accountId),
    );
  }
  const results = await db.$client.batch<{ id: string }>([
    db.$client
      .prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)")
      .bind(input.challenge.nonce, input.challenge.expiresAt.getTime()),
    ...authorize,
    // counterのCASと隣接させる。同じcounterを並行送信した敗者にはセッションを作らない。
    db.$client
      .prepare(`INSERT INTO sessions (id, account_id, installation_id, token_hash, created_at, expires_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1 RETURNING id`)
      .bind(
        id,
        input.accountId,
        input.installationId,
        input.session.tokenHash,
        now.getTime(),
        input.session.expiresAt.getTime(),
      ),
    ...(proof.kind !== "initial"
      ? []
      : [
          db.$client
            .prepare(`DELETE FROM sessions
      WHERE installation_id = ?1 AND account_id = ?2 AND id <> ?3
        AND EXISTS (SELECT 1 FROM sessions WHERE id = ?3)`)
            .bind(input.installationId, input.accountId, id),
        ]),
    db.$client
      .prepare(`DELETE FROM sessions WHERE installation_id = ?1 AND account_id = ?2
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ?3) AND id NOT IN (
        SELECT id FROM sessions WHERE installation_id = ?1 AND account_id = ?2
        ORDER BY (id = ?3) DESC, created_at DESC, id DESC LIMIT ?4)`)
      .bind(input.installationId, input.accountId, id, MAX_SESSIONS_PER_INSTALLATION),
    db.$client
      .prepare(`UPDATE installations SET last_used_at = ?3
      WHERE id = ?1 AND account_id = ?2 AND last_used_at < ?3 - 86400000
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ?4)`)
      .bind(input.installationId, input.accountId, now.getTime(), id),
  ]);
  const created = results[authorize.length + 1];
  return created?.results[0]?.id;
}

export type ActiveSession = { sessionId: string; accountId: string; installationId: string };

/** セッションのトークンのハッシュから、使えるセッション (期限内で、取り消しておらず、インストールとアカウントが有効) を探す。 */
export async function findActiveSession(
  db: Db,
  tokenHash: string,
  now = new Date(),
  requiredAttestation?: { appId: string; environment: string },
): Promise<ActiveSession | undefined> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      accountId: sessions.accountId,
      installationId: sessions.installationId,
    })
    .from(sessions)
    .innerJoin(installations, eq(sessions.installationId, installations.id))
    .innerJoin(notificationAccounts, eq(sessions.accountId, notificationAccounts.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        isNull(installations.revokedAt),
        eq(installations.accountId, sessions.accountId),
        eq(notificationAccounts.state, "active"),
        requiredAttestation === undefined
          ? undefined
          : exists(
              db
                .select({ id: installationAttestations.installationId })
                .from(installationAttestations)
                .where(
                  and(
                    eq(installationAttestations.installationId, installations.id),
                    eq(installationAttestations.appId, requiredAttestation.appId),
                    eq(
                      installationAttestations.environment,
                      requiredAttestation.environment === "production"
                        ? "production"
                        : "development",
                    ),
                    eq(installations.attestationState, "verified"),
                  ),
                ),
            ),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 期限を過ぎたチャレンジとセッションの記録を、それぞれ `limit` 件まで消し、表ごとに消した数を返す (定期の掃除で使う)。 */
export async function deleteExpiredAuthRecords(
  db: Db,
  now: Date,
  limit = 500,
): Promise<{ challenges: number; sessions: number }> {
  const [challenges, expiredSessions] = await db.$client.batch([
    db.$client
      .prepare(
        "DELETE FROM used_challenges WHERE rowid IN (SELECT rowid FROM used_challenges WHERE expires_at < ?1 LIMIT ?2)",
      )
      .bind(now.getTime(), limit),
    db.$client
      .prepare(
        "DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at < ?1 LIMIT ?2)",
      )
      .bind(now.getTime(), limit),
  ]);
  return {
    challenges: challenges?.meta.changes ?? 0,
    sessions: expiredSessions?.meta.changes ?? 0,
  };
}
