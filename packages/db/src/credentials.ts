import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Db } from "./db";
import type { ConsumedChallenge } from "./enroll";
import { notificationAccounts, relayCredentials } from "./schema";

export type ActiveRelayCredential = { id: string; accountId: string };

/** 使った時刻を書き直す間隔。中継のたびに D1 へ書かないよう、これより前に書いたときだけ書き直す。 */
export const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

/** 中継の資格情報を置く。DB に置くのはハッシュだけ (平文の秘密は呼ぶ側が 1 回だけ見せる。AUTH-002)。 */
export async function createRelayCredential(
  db: Db,
  input: { accountId: string; secretHash: string; expiresAt?: Date },
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

/** 使える資格情報 (取り消しておらず、期限内で、アカウントが有効) をハッシュで探す。送り先のアカウントは、これだけで決まる。 */
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
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * 中継の資格情報を入れ替える。チャレンジを使ったものとして記録し (2 回目は UNIQUE で失敗する)、アカウントの使える資格情報を
 * すべて取り消して、新しいものを置く (1 つのバッチ)。インストールがそのアカウントの有効なものでなければ、何も変えない。
 * 置けたら新しい資格情報の ID。端末の鍵の署名は、呼ぶ側が確かめてから呼ぶ。
 */
export async function rotateRelayCredential(
  db: Db,
  input: {
    accountId: string;
    installationId: string;
    challenge: ConsumedChallenge;
    secretHash: string;
  },
  now = new Date(),
): Promise<string | undefined> {
  const id = crypto.randomUUID();
  // バッチの途中で、インストールの取り消しやアカウントの停止が挟まっても、止めたアカウントに資格情報を作らない。
  const activeInstallation = `EXISTS (
    SELECT 1 FROM installations
    INNER JOIN notification_accounts ON notification_accounts.id = installations.account_id
    WHERE installations.id = ?2 AND installations.account_id = ?1
      AND installations.revoked_at IS NULL AND notification_accounts.state = 'active')`;
  const [, , created] = await db.$client.batch<{ id: string }>([
    db.$client
      .prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)")
      .bind(input.challenge.nonce, input.challenge.expiresAt.getTime()),
    db.$client
      .prepare(`
        UPDATE relay_credentials SET revoked_at = ?3
        WHERE account_id = ?1 AND revoked_at IS NULL AND ${activeInstallation}`)
      .bind(input.accountId, input.installationId, now.getTime()),
    db.$client
      .prepare(`
        INSERT INTO relay_credentials (id, account_id, secret_hash, created_at)
        SELECT ?3, ?1, ?4, ?5 WHERE ${activeInstallation}
        RETURNING id`)
      .bind(input.accountId, input.installationId, id, input.secretHash, now.getTime()),
  ]);
  return created?.results[0]?.id;
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
