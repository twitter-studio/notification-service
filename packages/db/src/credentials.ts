import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { Db } from "./db";
import { notificationAccounts, relayCredentials } from "./schema";

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
): Promise<{ id: string; accountId: string } | undefined> {
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
