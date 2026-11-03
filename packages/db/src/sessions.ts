import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "./db";
import type { ConsumedChallenge, NewSession } from "./enroll";
import { installations, notificationAccounts, sessions } from "./schema";

/** 有効なインストール (取り消しておらず、アカウントが有効) を ID で探す。セッションを作り直すときの署名の確かめに使う。 */
export async function findActiveInstallation(
  db: Db,
  installationId: string,
): Promise<{ accountId: string; publicKey: string } | undefined> {
  const rows = await db
    .select({ accountId: installations.accountId, publicKey: installations.publicKey })
    .from(installations)
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
  },
  now = new Date(),
): Promise<string | undefined> {
  const id = crypto.randomUUID();
  const [, , created] = await db.$client.batch<{ id: string }>([
    db.$client
      .prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)")
      .bind(input.challenge.nonce, input.challenge.expiresAt.getTime()),
    db.$client
      .prepare(`
        DELETE FROM sessions
        WHERE installation_id = ?1 AND account_id = ?2 AND id NOT IN (
          SELECT id FROM sessions
          WHERE installation_id = ?1 AND revoked_at IS NULL AND expires_at > ?3
          ORDER BY created_at DESC, id DESC LIMIT ?4)`)
      .bind(
        input.installationId,
        input.accountId,
        now.getTime(),
        MAX_SESSIONS_PER_INSTALLATION - 1,
      ),
    db.$client
      .prepare(`
        INSERT INTO sessions (id, account_id, installation_id, token_hash, created_at, expires_at)
        SELECT ?1, installations.account_id, installations.id, ?4, ?5, ?6 FROM installations
        INNER JOIN notification_accounts ON notification_accounts.id = installations.account_id
        WHERE installations.id = ?3 AND installations.account_id = ?2
          AND installations.revoked_at IS NULL AND notification_accounts.state = 'active'
        RETURNING id`)
      .bind(
        id,
        input.accountId,
        input.installationId,
        input.session.tokenHash,
        now.getTime(),
        input.session.expiresAt.getTime(),
      ),
  ]);
  return created?.results[0]?.id;
}

export type ActiveSession = { sessionId: string; accountId: string; installationId: string };

/** セッションのトークンのハッシュから、使えるセッション (期限内で、取り消しておらず、インストールとアカウントが有効) を探す。 */
export async function findActiveSession(
  db: Db,
  tokenHash: string,
  now = new Date(),
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
