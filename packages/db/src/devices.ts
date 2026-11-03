import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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
 * インストールの端末 (APNs のトークン) を登録する。インストールに端末は 1 つで、トークンが変わったら同じ行を書き換え、
 * トークンを持っていることの確かめ (`verified_at`) をやり直す。利用者が止めた端末は止めたまま、APNs が無効と返した端末は有効に戻す。
 */
export async function registerDeviceToken(
  db: Db,
  input: DeviceRegistration,
  now = new Date(),
): Promise<DeviceRegistrationResult> {
  // インストールの持ち主と状態の確かめは、書き込みと同じ文の中で行い、確かめてから書くまでの間に取り消されても書かないようにする。
  const ownsInstallation = `
    SELECT installations.id FROM installations
    INNER JOIN notification_accounts ON notification_accounts.id = installations.account_id
    WHERE installations.id = ?1 AND installations.account_id = ?2
      AND installations.revoked_at IS NULL AND notification_accounts.state = 'active'`;
  // 同じトークンを、ほかのインストールの行が持っていたら、確かめていない行、取り消したインストールや有効でないアカウントの行、
  // APNs が無効と返した行に限って、新しい登録に譲る。確かめた有効な行は譲らず conflict にする
  // (トークンを知っているだけでは、持ち主の証明にならない。設計書 §2、§3.8。ADR-0004)。
  const release = db.$client
    .prepare(`
      DELETE FROM devices
      WHERE token_fingerprint = ?3 AND apns_environment = ?4 AND topic = ?5 AND installation_id != ?1
        AND EXISTS (${ownsInstallation})
        AND (
          verified_at IS NULL
          OR state = 'invalidated'
          OR installation_id IN (
            SELECT installations.id FROM installations
            INNER JOIN notification_accounts ON notification_accounts.id = installations.account_id
            WHERE installations.revoked_at IS NOT NULL OR notification_accounts.state != 'active'
          )
        )`)
    .bind(
      input.installationId,
      input.accountId,
      input.tokenFingerprint,
      input.apnsEnvironment,
      input.topic,
    );
  const upsert = db.$client
    .prepare(`
      INSERT INTO devices (id, installation_id, apns_token_ciphertext, token_fingerprint, apns_environment, topic, state, verified_at, updated_at)
      SELECT ?6, id, ?7, ?3, ?4, ?5, 'active', NULL, ?8 FROM (${ownsInstallation})
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
      input.installationId,
      input.accountId,
      input.tokenFingerprint,
      input.apnsEnvironment,
      input.topic,
      crypto.randomUUID(),
      input.apnsTokenCiphertext,
      now.getTime(),
    );
  try {
    // 2 つの文は 1 つのバッチ (まとめて成功するか、まとめて取り消される) で行う。
    const [, upserted] = await db.$client.batch<{ id: string }>([release, upsert]);
    const row = upserted?.results[0];
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

/**
 * 端末がこのトークンを持っていることを確かめた (確かめ方は API-002 で決める)。確かめたトークンの指紋が今のトークンと合い、
 * 自分のアカウントの端末のときだけ記録する。
 */
export async function markDeviceVerified(
  db: Db,
  input: { accountId: string; deviceId: string; tokenFingerprint: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ verifiedAt: now, updatedAt: now })
    .where(
      and(
        eq(devices.id, input.deviceId),
        eq(devices.tokenFingerprint, input.tokenFingerprint),
        inArray(devices.installationId, installationsOf(db, input.accountId)),
      ),
    )
    .returning({ id: devices.id });
  return rows.length > 0;
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
