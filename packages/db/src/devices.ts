import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db";
import { isUniqueViolation } from "./errors";
import { devices, installations, notificationAccounts } from "./schema";

export type ApnsEnvironment = "sandbox" | "production";

export type DeviceRegistration = {
  accountId: string;
  installationId: string;
  apnsTokenCiphertext: string;
  tokenFingerprint: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

export type DeviceRegistrationResult =
  | { kind: "registered"; deviceId: string }
  /** インストールがそのアカウントのものでない、取り消し済み、アカウントが有効でない。 */
  | { kind: "rejected" }
  /** 同じトークンを、ほかのインストールが持っている。 */
  | { kind: "conflict" };

export type ActiveDevice = {
  id: string;
  apnsTokenCiphertext: string;
  tokenFingerprint: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

/**
 * インストールの端末 (APNs のトークン) を登録する。インストールに端末は 1 つで、トークンが変わったら同じ行を書き換える。
 * 利用者が止めた端末は止めたまま、APNs が無効と返した端末は有効に戻す。
 */
export async function registerDeviceToken(
  db: Db,
  input: DeviceRegistration,
  now = new Date(),
): Promise<DeviceRegistrationResult> {
  // インストールの持ち主と状態の確かめと書き込みを 1 つの文にし、確かめてから書くまでの間に取り消されても書かないようにする。
  // ほかのインストールが同じトークンを持っていたら、移さずに conflict にする。トークンだけでは持ち主の証明にならないため
  // (設計書 §2、§3.8)。移すときは、トークンを持っていることを別に確かめてから (APNS-002 などで決める)。
  try {
    const rows = await db.all<{ id: string }>(sql`
      INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic, state, updated_at)
      SELECT ${crypto.randomUUID()}, installations.id, ${input.apnsTokenCiphertext}, ${input.tokenFingerprint},
        ${input.apnsEnvironment}, ${input.topic}, 'active', ${now.getTime()}
      FROM installations
      INNER JOIN notification_accounts ON notification_accounts.id = installations.account_id
      WHERE installations.id = ${input.installationId}
        AND installations.account_id = ${input.accountId}
        AND installations.revoked_at IS NULL
        AND notification_accounts.state = 'active'
      ON CONFLICT (installation_id) DO UPDATE SET
        apns_token_ciphertext = excluded.apns_token_ciphertext,
        token_fingerprint = excluded.token_fingerprint,
        apns_environment = excluded.apns_environment,
        topic = excluded.topic,
        state = CASE devices.state WHEN 'disabled_by_user' THEN 'disabled_by_user' ELSE 'active' END,
        updated_at = excluded.updated_at
      RETURNING id
    `);
    const row = rows[0];
    return row === undefined ? { kind: "rejected" } : { kind: "registered", deviceId: row.id };
  } catch (error) {
    if (
      isUniqueViolation(error, "devices.token_fingerprint, devices.apns_environment, devices.topic")
    ) {
      return { kind: "conflict" };
    }
    throw error;
  }
}

/** そのアカウントのインストールの ID を返す副問い合わせ。端末を、アカウントをまたいで書き換えないための条件に使う。 */
function installationsOf(db: Db, accountId: string) {
  return db
    .select({ id: installations.id })
    .from(installations)
    .where(eq(installations.accountId, accountId));
}

/** 利用者が通知を止める。ほかのアカウントの端末なら false。 */
export async function disableDeviceByUser(
  db: Db,
  input: { accountId: string; deviceId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ state: "disabled_by_user", updatedAt: now })
    .where(
      and(
        eq(devices.id, input.deviceId),
        inArray(devices.installationId, installationsOf(db, input.accountId)),
      ),
    )
    .returning({ id: devices.id });
  return rows.length > 0;
}

/** 利用者が止めた通知を、また受け取るようにする。ほかのアカウントの端末、止めていない端末なら false。 */
export async function enableDeviceByUser(
  db: Db,
  input: { accountId: string; deviceId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ state: "active", updatedAt: now })
    .where(
      and(
        eq(devices.id, input.deviceId),
        eq(devices.state, "disabled_by_user"),
        inArray(devices.installationId, installationsOf(db, input.accountId)),
      ),
    )
    .returning({ id: devices.id });
  return rows.length > 0;
}

/**
 * APNs がトークンを無効と返した端末を止める (410 Unregistered など)。送ってから応答までの間にトークンが入れ替わっていたら、
 * 新しいトークンを止めないよう、送ったときのトークンの指紋と合うときだけ止める。
 */
export async function invalidateDevice(
  db: Db,
  input: { deviceId: string; tokenFingerprint: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ state: "invalidated", updatedAt: now })
    .where(
      and(
        eq(devices.id, input.deviceId),
        eq(devices.tokenFingerprint, input.tokenFingerprint),
        eq(devices.state, "active"),
      ),
    )
    .returning({ id: devices.id });
  return rows.length > 0;
}

/** 通知を送る先: 有効なアカウントの、取り消していないインストールの、有効な端末。 */
export async function listActiveDevices(db: Db, accountId: string): Promise<ActiveDevice[]> {
  return db
    .select({
      id: devices.id,
      apnsTokenCiphertext: devices.apnsTokenCiphertext,
      tokenFingerprint: devices.tokenFingerprint,
      apnsEnvironment: devices.apnsEnvironment,
      topic: devices.topic,
    })
    .from(devices)
    .innerJoin(installations, eq(devices.installationId, installations.id))
    .innerJoin(notificationAccounts, eq(installations.accountId, notificationAccounts.id))
    .where(
      and(
        eq(notificationAccounts.id, accountId),
        eq(notificationAccounts.state, "active"),
        isNull(installations.revokedAt),
        eq(devices.state, "active"),
      ),
    );
}
