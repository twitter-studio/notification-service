import { and, eq, exists, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "./db";
import { installationsOf } from "./devices";
import {
  deliveryDedup,
  devices,
  deviceVerifications,
  installations,
  notificationAccounts,
  relayCredentials,
  relayUsage,
  sessions,
} from "./schema";

/**
 * インストールを取り消す (鍵をなくしたときのリセットなど)。端末の行も消し、持っていたトークンを手放す。
 * アカウントの中継の資格情報も取り消す。v1 のアカウントはインストールを 1 つだけ持ち、取り消した後は、持ち主が資格情報を
 * 取り消す手段 (セッション) を持てないため (ADR-0007)。ほかのアカウントのもの、取り消し済みのものなら false。
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
  const [, , , , revoked] = await db.batch([
    db
      .delete(sessions)
      .where(
        and(
          eq(sessions.installationId, input.installationId),
          inArray(
            sessions.installationId,
            db.select({ id: installations.id }).from(installations).where(owned),
          ),
        ),
      ),
    db.delete(deviceVerifications).where(
      inArray(
        deviceVerifications.deviceId,
        db
          .select({ id: devices.id })
          .from(devices)
          .where(
            and(
              eq(devices.installationId, input.installationId),
              inArray(
                devices.installationId,
                db.select({ id: installations.id }).from(installations).where(owned),
              ),
            ),
          ),
      ),
    ),
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
      .update(relayCredentials)
      .set({ revokedAt: now })
      .where(
        and(
          eq(relayCredentials.accountId, input.accountId),
          isNull(relayCredentials.revokedAt),
          exists(db.select({ id: installations.id }).from(installations).where(owned)),
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
    db.delete(relayUsage).where(eq(relayUsage.accountId, input.accountId)),
    db.delete(deviceVerifications).where(
      inArray(
        deviceVerifications.deviceId,
        db
          .select({ id: devices.id })
          .from(devices)
          .where(inArray(devices.installationId, installationsOf(db, input.accountId))),
      ),
    ),
    db.delete(devices).where(inArray(devices.installationId, installationsOf(db, input.accountId))),
    db.delete(relayCredentials).where(eq(relayCredentials.accountId, input.accountId)),
    db.delete(sessions).where(eq(sessions.accountId, input.accountId)),
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
  return results[7].length > 0;
}

/** 使われなくなったとみなすまでの期間。アプリの起動の間隔より十分に長くする (notification-service#20、ADR-0010)。 */
export const ABANDONED_ACCOUNT_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * 使われなくなったアカウントの条件 (`notification_accounts` の行について)。有効なアカウントで、`since` (引数 `since`) より後に、
 * 次のどれもない。
 * - アプリが使ったインストール (`last_used_at`)。取り消したインストールは、取り消した時刻も使った時刻とみなす (取り消した鍵での
 *   登録し直しを拒む 403 を、取り消してから期間のあいだ続けるため)。
 * - 使われた、取り消していない中継の資格情報で、アカウントに送れる端末 (有効で、確かめたもの) があるもの。アプリを開かずに通知だけを
 *   受けている利用者は消さない。送れる端末のないアカウントの資格情報 (鍵をなくした後の古い資格情報、漏れた資格情報) が使われても、
 *   使ったとはみなさない。
 */
function abandoned(since: string): string {
  return `
    notification_accounts.state = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM installations
      WHERE installations.account_id = notification_accounts.id
        AND (installations.last_used_at >= ${since} OR installations.revoked_at >= ${since}))
    AND NOT (
      EXISTS (
        SELECT 1 FROM relay_credentials
        WHERE relay_credentials.account_id = notification_accounts.id
          AND relay_credentials.revoked_at IS NULL AND relay_credentials.last_used_at >= ${since})
      AND EXISTS (
        SELECT 1 FROM devices
        INNER JOIN installations ON installations.id = devices.installation_id
        WHERE installations.account_id = notification_accounts.id AND installations.revoked_at IS NULL
          AND devices.state = 'active' AND devices.verified_at IS NOT NULL))`;
}

/** 使われなくなったアカウントを、`afterRowid` より後ろ (rowid の順) から `limit` 件まで探す。 */
export async function findAbandonedAccounts(
  db: Db,
  input: { since: Date; afterRowid?: number },
  limit = 100,
): Promise<{ accountIds: string[]; lastRowid: number }> {
  const afterRowid = input.afterRowid ?? 0;
  const { results } = await db.$client
    .prepare(`
      SELECT rowid, id FROM notification_accounts
      WHERE rowid > ?2 AND ${abandoned("?1")}
      ORDER BY rowid LIMIT ?3`)
    .bind(input.since.getTime(), afterRowid, limit)
    .all<{ rowid: number; id: string }>();
  const rows = results as { rowid: number; id: string }[];
  return { accountIds: rows.map((row) => row.id), lastRowid: rows.at(-1)?.rowid ?? afterRowid };
}

/**
 * 使われなくなったアカウントを消す (`deleteAccount` と同じものを消す)。消す直前にもう一度確かめ、使われていたら何もしない。
 * 1 つのバッチで、先にアカウントに消した印 (`deleted` と、この呼び出しの時刻) を付け、その印が付いたときだけ子の行を消す。
 * 端末の行は、状態に関わらず消す (利用者が止めた行、引き継がれなかった確かめたままの行も)。消したら true。
 */
export async function deleteAbandonedAccount(
  db: Db,
  input: { accountId: string; since: Date },
  now = new Date(),
): Promise<boolean> {
  const marked = `EXISTS (
    SELECT 1 FROM notification_accounts WHERE id = ?1 AND state = 'deleted' AND deleted_at = ?2)`;
  const installationsOfAccount = "SELECT id FROM installations WHERE account_id = ?1";
  const devicesOfAccount = `SELECT id FROM devices WHERE installation_id IN (${installationsOfAccount})`;
  const children = [
    `DELETE FROM delivery_dedup WHERE account_id = ?1 AND ${marked}`,
    `DELETE FROM relay_usage WHERE account_id = ?1 AND ${marked}`,
    `DELETE FROM device_verifications WHERE device_id IN (${devicesOfAccount}) AND ${marked}`,
    `DELETE FROM devices WHERE installation_id IN (${installationsOfAccount}) AND ${marked}`,
    `DELETE FROM relay_credentials WHERE account_id = ?1 AND ${marked}`,
    `DELETE FROM sessions WHERE account_id = ?1 AND ${marked}`,
    `DELETE FROM installations WHERE account_id = ?1 AND ${marked}`,
  ];
  const [mark] = await db.$client.batch<{ id: string }>([
    db.$client
      .prepare(`
        UPDATE notification_accounts SET state = 'deleted', deleted_at = ?3
        WHERE id = ?1 AND ${abandoned("?2")}
        RETURNING id`)
      .bind(input.accountId, input.since.getTime(), now.getTime()),
    ...children.map((sql) => db.$client.prepare(sql).bind(input.accountId, now.getTime())),
  ]);
  return (mark?.results.length ?? 0) > 0;
}
