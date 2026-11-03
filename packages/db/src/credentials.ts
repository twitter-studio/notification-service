import { and, eq, exists, gt, isNull, lt, or } from "drizzle-orm";
import type { Db } from "./db";
import type { ConsumedChallenge } from "./enroll";
import { installations, notificationAccounts, relayCredentials } from "./schema";
import type { BearerTokenHash } from "./types";

export type ActiveRelayCredential = { id: string; accountId: string };

/** 使った時刻を書き直す間隔。中継のたびに D1 へ書かないよう、これより前に書いたときだけ書き直す。 */
export const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/** 中継の資格情報を置く。DB に置くのはハッシュだけ (平文の秘密は呼ぶ側が 1 回だけ見せる。AUTH-002)。 */
export async function createRelayCredential(
  db: Db,
  input: { accountId: string; secretHash: BearerTokenHash; expiresAt?: Date },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(relayCredentials).values({
    id,
    accountId: input.accountId,
    secretHash: input.secretHash,
    expiresAt: input.expiresAt ?? null,
  });
  return id;
}

/**
 * 使える資格情報 (取り消しておらず、期限内で、アカウントが有効で、取り消していないインストールがある) をハッシュで探す。
 * 送り先のアカウントは、これだけで決まる。インストールを取り消したアカウントの資格情報は、持ち主がもう取り消せないので使わせない。
 */
export async function findActiveRelayCredential(
  db: Db,
  secretHash: string,
  now = new Date(),
): Promise<ActiveRelayCredential | undefined> {
  const rows = await db
    .select({ id: relayCredentials.id, accountId: relayCredentials.accountId })
    .from(relayCredentials)
    .innerJoin(notificationAccounts, eq(relayCredentials.accountId, notificationAccounts.id))
    .where(
      and(
        eq(relayCredentials.secretHash, secretHash),
        isNull(relayCredentials.revokedAt),
        or(isNull(relayCredentials.expiresAt), gt(relayCredentials.expiresAt, now)),
        eq(notificationAccounts.state, "active"),
        exists(
          db
            .select({ id: installations.id })
            .from(installations)
            .where(
              and(
                eq(installations.accountId, relayCredentials.accountId),
                isNull(installations.revokedAt),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 1 つのアカウントが 1 時間に作れる中継の資格情報の数 (登録で作ったものを含む)。行が残るので、DB で正確に数える。 */
export const MAX_RELAY_CREDENTIALS_PER_HOUR = 10;

export type RelayCredentialRotation =
  | { kind: "rotated"; credentialId: string }
  /** インストールがそのアカウントの有効なものでない、または 1 時間に作れる数を超えた。何も変えていない。 */
  | { kind: "rejected" };

/**
 * 中継の資格情報を入れ替える。チャレンジを使ったものとして記録し (2 回目は UNIQUE で失敗する)、アカウントの使える資格情報を
 * すべて取り消して、新しいものを置く (1 つのバッチ)。端末の鍵の署名は、呼ぶ側が確かめてから呼ぶ。
 */
export async function rotateRelayCredential(
  db: Db,
  input: {
    accountId: string;
    installationId: string;
    challenge: ConsumedChallenge;
    secretHash: BearerTokenHash;
  },
  now = new Date(),
): Promise<RelayCredentialRotation> {
  const id = crypto.randomUUID();
  // 取り消しと置き直しの両方を、同じ条件で絞る。署名を確かめてからバッチまでのあいだにインストールやアカウントが止まったとき、
  // 上限を超えたときに、前の資格情報だけを取り消して、使える資格情報のないアカウントにしない。
  const allowed = `EXISTS (
      SELECT 1 FROM installations
      INNER JOIN notification_accounts ON notification_accounts.id = installations.account_id
      WHERE installations.id = ?2 AND installations.account_id = ?1
        AND installations.revoked_at IS NULL AND notification_accounts.state = 'active')
    AND (SELECT count(*) FROM relay_credentials WHERE account_id = ?1 AND created_at > ?3) < ?4`;
  const since = now.getTime() - 60 * 60 * 1000;
  const [, , created] = await db.$client.batch<{ id: string }>([
    db.$client
      .prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)")
      .bind(input.challenge.nonce, input.challenge.expiresAt.getTime()),
    db.$client
      .prepare(`
        UPDATE relay_credentials SET revoked_at = ?5
        WHERE account_id = ?1 AND revoked_at IS NULL AND ${allowed}`)
      .bind(
        input.accountId,
        input.installationId,
        since,
        MAX_RELAY_CREDENTIALS_PER_HOUR,
        now.getTime(),
      ),
    db.$client
      .prepare(`
        INSERT INTO relay_credentials (id, account_id, secret_hash, created_at)
        SELECT ?5, ?1, ?6, ?7 WHERE ${allowed}
        RETURNING id`)
      .bind(
        input.accountId,
        input.installationId,
        since,
        MAX_RELAY_CREDENTIALS_PER_HOUR,
        id,
        input.secretHash,
        now.getTime(),
      ),
  ]);
  const credentialId = created?.results[0]?.id;
  return credentialId === undefined ? { kind: "rejected" } : { kind: "rotated", credentialId };
}

/** 取り消してから `before` より前になった資格情報を、`limit` 件まで消し、消した数を返す (定期の掃除で使う)。 */
export async function deleteRevokedRelayCredentials(
  db: Db,
  before: Date,
  limit = 500,
): Promise<number> {
  const result = await db.$client
    .prepare(
      "DELETE FROM relay_credentials WHERE rowid IN (SELECT rowid FROM relay_credentials WHERE revoked_at < ?1 LIMIT ?2)",
    )
    .bind(before.getTime(), limit)
    .run();
  return result.meta.changes;
}

/** アカウントの資格情報を取り消す。ほかのアカウントのもの、取り消し済みのものなら false。 */
export async function revokeRelayCredential(
  db: Db,
  input: { accountId: string; credentialId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(relayCredentials)
    .set({ revokedAt: now })
    .where(
      and(
        eq(relayCredentials.id, input.credentialId),
        eq(relayCredentials.accountId, input.accountId),
        isNull(relayCredentials.revokedAt),
      ),
    )
    .returning({ id: relayCredentials.id });
  return rows.length > 0;
}

/** 使った時刻を残す。取り消したもの、ほかのアカウントのものには書かない。`LAST_USED_RESOLUTION_MS` より前に書いたときだけ書き直す。 */
export async function markRelayCredentialUsed(
  db: Db,
  input: { accountId: string; credentialId: string },
  now = new Date(),
): Promise<void> {
  await db
    .update(relayCredentials)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(relayCredentials.id, input.credentialId),
        eq(relayCredentials.accountId, input.accountId),
        isNull(relayCredentials.revokedAt),
        or(
          isNull(relayCredentials.lastUsedAt),
          lt(relayCredentials.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)),
        ),
      ),
    );
}
