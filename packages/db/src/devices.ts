import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "./db";
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
  | { kind: "rejected" };

export type ActiveDevice = {
  id: string;
  apnsTokenCiphertext: string;
  tokenFingerprint: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

/** 有効なインストール (取り消しておらず、アカウントが有効) の ID を返す SQL。?1 にアカウントの ID を渡す。 */
const ACTIVE_INSTALLATIONS_OF_ACCOUNT = `
  SELECT installations.id FROM installations
  INNER JOIN notification_accounts ON notification_accounts.id = installations.account_id
  WHERE installations.account_id = ?1 AND installations.revoked_at IS NULL AND notification_accounts.state = 'active'`;

/**
 * インストールの端末 (APNs のトークン) を登録する。インストールに端末は 1 つで、トークンが変わったら同じ行を書き換え、
 * トークンを持っていることの確かめ (`verified_at`) をやり直す。利用者が止めた端末は止めたまま、APNs が無効と返した端末は有効に戻す。
 * ほかのインストールの行には触れない。同じトークンをほかの行が持っていても登録でき、確かめたときに引き継ぐ (`markDeviceVerified`)。
 */
export async function registerDeviceToken(
  db: Db,
  input: DeviceRegistration,
  now = new Date(),
): Promise<DeviceRegistrationResult> {
  // インストールの持ち主と状態の確かめは、書き込みと同じ文の中で行い、確かめてから書くまでの間に取り消されても書かないようにする。
  const row = await db.$client
    .prepare(`
      INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic, state, verified_at, updated_at)
      SELECT ?3, id, ?4, ?5, ?6, ?7, 'active', NULL, ?8 FROM (${ACTIVE_INSTALLATIONS_OF_ACCOUNT} AND installations.id = ?2)
      WHERE true
      ON CONFLICT (installation_id) DO UPDATE SET
        verified_at = CASE
          WHEN devices.token_fingerprint = excluded.token_fingerprint
            AND devices.apns_environment = excluded.apns_environment
            AND devices.topic = excluded.topic
          THEN devices.verified_at ELSE NULL END,
        apns_token_ciphertext = excluded.apns_token_ciphertext,
        token_fingerprint = excluded.token_fingerprint,
        apns_environment = excluded.apns_environment,
        topic = excluded.topic,
        state = CASE devices.state WHEN 'disabled_by_user' THEN 'disabled_by_user' ELSE 'active' END,
        updated_at = excluded.updated_at
      RETURNING id`)
    .bind(
      input.accountId,
      input.installationId,
      crypto.randomUUID(),
      input.apnsTokenCiphertext,
      input.tokenFingerprint,
      input.apnsEnvironment,
      input.topic,
      now.getTime(),
    )
    .first<{ id: string }>();
  return row === null ? { kind: "rejected" } : { kind: "registered", deviceId: row.id };
}

/**
 * 端末がこのトークンを持っていることを確かめた (確かめ方は API-002 で決める)。自分のアカウントの有効なインストールの端末で、
 * 確かめたトークンの指紋が今のトークンと合うときだけ記録する。同じトークンを確かめていたほかの行は、確かめを外す
 * (トークンを持っていると証明した側が引き継ぐ。ADR-0004)。記録したら true。
 */
export async function markDeviceVerified(
  db: Db,
  input: {
    accountId: string;
    deviceId: string;
    tokenFingerprint: string;
    apnsEnvironment: ApnsEnvironment;
    topic: string;
  },
  now = new Date(),
): Promise<boolean> {
  // 確かめの push を送ったトークン (指紋、環境、topic) が、今の端末と合うときだけ記録する。
  // 関数を呼ぶこと自体が引き継ぎになるので、呼ぶ側 (API-002) は、確かめの記録と突き合わせてから呼ぶ。
  const target = `
    SELECT devices.id FROM devices
    WHERE devices.id = ?2 AND devices.token_fingerprint = ?3 AND devices.apns_environment = ?5 AND devices.topic = ?6
      AND devices.installation_id IN (${ACTIVE_INSTALLATIONS_OF_ACCOUNT})`;
  // 2 つの文は同じ条件 (target) で守り、記録できないときは、ほかの行の確かめも外さない。1 つのバッチで行う。
  const release = db.$client
    .prepare(`
      UPDATE devices SET verified_at = NULL, updated_at = ?4
      WHERE id != ?2 AND verified_at IS NOT NULL
        AND (token_fingerprint, apns_environment, topic) = (SELECT token_fingerprint, apns_environment, topic FROM devices WHERE id = ?2)
        AND EXISTS (${target})`)
    .bind(
      input.accountId,
      input.deviceId,
      input.tokenFingerprint,
      now.getTime(),
      input.apnsEnvironment,
      input.topic,
    );
  const verify = db.$client
    .prepare(`
      UPDATE devices SET verified_at = ?4, updated_at = ?4
      WHERE id IN (${target})
      RETURNING id`)
    .bind(
      input.accountId,
      input.deviceId,
      input.tokenFingerprint,
      now.getTime(),
      input.apnsEnvironment,
      input.topic,
    );
  const [, verified] = await db.$client.batch<{ id: string }>([release, verify]);
  return (verified?.results.length ?? 0) > 0;
}

/** そのアカウントのインストールの ID を返す副問い合わせ。端末を、アカウントをまたいで書き換えないための条件に使う。 */
export function installationsOf(db: Db, accountId: string) {
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

/** 通知を送る先: 有効なアカウントの、取り消していないインストールの、有効で、トークンを持っていることを確かめた端末。 */
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
        isNotNull(devices.verifiedAt),
      ),
    );
}
