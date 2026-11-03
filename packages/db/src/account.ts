import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "./db";
import { installationsOf } from "./devices";
import {
  deliveryDedup,
  devices,
  installations,
  notificationAccounts,
  relayCredentials,
} from "./schema";

/**
 * インストールを取り消す (鍵をなくしたときのリセットなど)。端末の行も消し、持っていたトークンを手放す。
 * ほかのアカウントのもの、取り消し済みのものなら false。
 */
export async function revokeInstallation(
  db: Db,
  input: { accountId: string; installationId: string },
  now = new Date(),
): Promise<boolean> {
  const owned = and(
    eq(installations.id, input.installationId),
    eq(installations.accountId, input.accountId),
    isNull(installations.revokedAt),
  );
  const [, revoked] = await db.batch([
    db
      .delete(devices)
      .where(
        and(
          eq(devices.installationId, input.installationId),
          inArray(
            devices.installationId,
            db.select({ id: installations.id }).from(installations).where(owned),
          ),
        ),
      ),
    db
      .update(installations)
      .set({ revokedAt: now })
      .where(owned)
      .returning({ id: installations.id }),
  ]);
  return revoked.length > 0;
}

/**
 * アカウントを消す (ADR-0001 §5)。秘密と端末の情報 (インストール、端末、中継の資格情報、受け付けの記録) を消し、
 * アカウントの行は `deleted` として残す。外部キーは CASCADE にしていないので、子の行から順に、1 つのバッチで消す。
 */
export async function deleteAccount(
  db: Db,
  input: { accountId: string },
  now = new Date(),
): Promise<boolean> {
  const results = await db.batch([
    db.delete(deliveryDedup).where(eq(deliveryDedup.accountId, input.accountId)),
    db.delete(devices).where(inArray(devices.installationId, installationsOf(db, input.accountId))),
    db.delete(relayCredentials).where(eq(relayCredentials.accountId, input.accountId)),
    db.delete(installations).where(eq(installations.accountId, input.accountId)),
    db
      .update(notificationAccounts)
      .set({ state: "deleted", deletedAt: now })
      .where(
        and(
          eq(notificationAccounts.id, input.accountId),
          ne(notificationAccounts.state, "deleted"),
        ),
      )
      .returning({ id: notificationAccounts.id }),
  ]);
  return results[4].length > 0;
}
