import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "./db";
import type { ConsumedChallenge } from "./enroll";
import { devices, installations, notificationAccounts } from "./schema";
import type { BearerTokenHash, DeviceTokenCiphertext, DeviceTokenFingerprint } from "./types";

export type ApnsEnvironment = "sandbox" | "production";

export type DeviceRegistration = {
  accountId: string;
  installationId: string;
  apnsTokenCiphertext: DeviceTokenCiphertext;
  tokenFingerprint: DeviceTokenFingerprint;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

export type DeviceRegistrationResult =
  | { kind: "registered"; deviceId: string }
  /** インストールがそのアカウントのものでない、取り消し済み、アカウントが有効でない。 */
  | { kind: "rejected" };

export type ActiveDevice = {
  id: string;
  installationId: string;
  apnsTokenCiphertext: DeviceTokenCiphertext;
  tokenFingerprint: DeviceTokenFingerprint;
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
 * 署名に使ったチャレンジを、同じバッチの先頭で使ったものとして記録する (2 回目は UNIQUE で失敗する)。
 */
export async function registerDeviceToken(
  db: Db,
  input: DeviceRegistration & { challenge: ConsumedChallenge },
  now = new Date(),
): Promise<DeviceRegistrationResult> {
  const consume = db.$client
    .prepare("INSERT INTO used_challenges (nonce, expires_at) VALUES (?1, ?2)")
    .bind(input.challenge.nonce, input.challenge.expiresAt.getTime());
  // インストールの持ち主と状態の確かめは、書き込みと同じ文の中で行い、確かめてから書くまでの間に取り消されても書かないようにする。
  const upsert = db.$client
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
    );
  const [, upserted] = await db.$client.batch<{ id: string }>([consume, upsert]);
  const row = upserted?.results[0];
  return row === undefined ? { kind: "rejected" } : { kind: "registered", deviceId: row.id };
}

export type InstallationDevice = {
  id: string;
  state: "active" | "disabled_by_user" | "invalidated";
  verified: boolean;
};

/** アカウントの有効なインストールの端末を探す。ほかのアカウントのインストール、取り消したインストールなら undefined。 */
export async function findInstallationDevice(
  db: Db,
  input: { accountId: string; installationId: string },
): Promise<InstallationDevice | undefined> {
  const row = await db.$client
    .prepare(`
      SELECT id, state, verified_at FROM devices
      WHERE installation_id = ?2 AND installation_id IN (${ACTIVE_INSTALLATIONS_OF_ACCOUNT})`)
    .bind(input.accountId, input.installationId)
    .first<{ id: string; state: InstallationDevice["state"]; verified_at: number | null }>();
  return row === null
    ? undefined
    : { id: row.id, state: row.state, verified: row.verified_at !== null };
}

/**
 * 端末に、トークンを持っていることの確かめの code (のハッシュ) を置く。今の端末のトークン (指紋、環境、topic) を一緒に残す。
 * 前の code があれば置き換える。自分のアカウントの有効なインストールの端末でなければ false。
 */
export async function createDeviceVerification(
  db: Db,
  input: { accountId: string; deviceId: string; codeHash: BearerTokenHash; expiresAt: Date },
  now = new Date(),
): Promise<boolean> {
  const row = await db.$client
    .prepare(`
      INSERT INTO device_verifications (device_id, code_hash, token_fingerprint, apns_environment, topic, expires_at, created_at)
      SELECT devices.id, ?3, devices.token_fingerprint, devices.apns_environment, devices.topic, ?4, ?5 FROM devices
      WHERE devices.id = ?2 AND devices.installation_id IN (${ACTIVE_INSTALLATIONS_OF_ACCOUNT})
      ON CONFLICT (device_id) DO UPDATE SET
        code_hash = excluded.code_hash,
        token_fingerprint = excluded.token_fingerprint,
        apns_environment = excluded.apns_environment,
        topic = excluded.topic,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
      RETURNING device_id`)
    .bind(input.accountId, input.deviceId, input.codeHash, input.expiresAt.getTime(), now.getTime())
    .first<{ device_id: string }>();
  return row !== null;
}

/** 期限を過ぎた確かめの記録を、`limit` 件まで消し、消した数を返す (定期の掃除で使う)。 */
export async function deleteExpiredDeviceVerifications(
  db: Db,
  now: Date,
  limit = 500,
): Promise<number> {
  const result = await db.$client
    .prepare(
      "DELETE FROM device_verifications WHERE rowid IN (SELECT rowid FROM device_verifications WHERE expires_at < ?1 LIMIT ?2)",
    )
    .bind(now.getTime(), limit)
    .run();
  return result.meta.changes;
}

/**
 * 端末がこのトークンを持っていることを確かめた。アプリが返した確かめの code (のハッシュ) が、期限内の確かめの記録と合い、
 * 記録を作ったときのトークン (指紋、環境、topic) が今の端末と合い、自分のアカウントの有効なインストールの端末のときだけ記録する。
 * 同じトークンを確かめていたほかの行は、確かめを外す (トークンを持っていると証明した側が引き継ぐ。ADR-0004)。
 * 使った確かめの記録は消す。記録したら true。
 */
export async function markDeviceVerified(
  db: Db,
  input: { accountId: string; deviceId: string; codeHash: BearerTokenHash },
  now = new Date(),
): Promise<boolean> {
  // 確かめの記録との突き合わせを、書き込みと同じ文の中で行う。記録がなければ (証明がなければ)、引き継ぎは起きない。
  const target = `
    SELECT devices.id FROM devices
    INNER JOIN device_verifications ON device_verifications.device_id = devices.id
    WHERE devices.id = ?2 AND device_verifications.code_hash = ?3 AND device_verifications.expires_at > ?4
      AND device_verifications.token_fingerprint = devices.token_fingerprint
      AND device_verifications.apns_environment = devices.apns_environment
      AND device_verifications.topic = devices.topic
      AND devices.installation_id IN (${ACTIVE_INSTALLATIONS_OF_ACCOUNT})`;
  // 引き継ぎと記録の 2 つの文は同じ条件 (target) で守り、記録できないときは、ほかの行の確かめも外さない。1 つのバッチで行う。
  const release = db.$client
    .prepare(`
      UPDATE devices SET verified_at = NULL, updated_at = ?4
      WHERE id != ?2 AND verified_at IS NOT NULL
        AND (token_fingerprint, apns_environment, topic) = (SELECT token_fingerprint, apns_environment, topic FROM devices WHERE id = ?2)
        AND EXISTS (${target})`)
    .bind(input.accountId, input.deviceId, input.codeHash, now.getTime());
  const verify = db.$client
    .prepare(`
      UPDATE devices SET verified_at = ?4, updated_at = ?4
      WHERE id IN (${target})
      RETURNING id`)
    .bind(input.accountId, input.deviceId, input.codeHash, now.getTime());
  // code は 1 回だけ使える。合った記録は、確かめられたかに関わらず消す (期限切れ、トークンが変わったものも使えない)。
  const consume = db.$client
    .prepare("DELETE FROM device_verifications WHERE device_id = ?1 AND code_hash = ?2")
    .bind(input.deviceId, input.codeHash);
  const [, verified] = await db.$client.batch<{ id: string }>([release, verify, consume]);
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
  input: { deviceId: string; tokenFingerprint: DeviceTokenFingerprint },
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
  const rows = await db
    .select({
      id: devices.id,
      installationId: devices.installationId,
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
  // DB の列は、DB の CHECK で形を確かめた暗号文と指紋だけが入る (schema.ts)。
  return rows.map((row) => ({
    ...row,
    apnsTokenCiphertext: row.apnsTokenCiphertext as DeviceTokenCiphertext,
    tokenFingerprint: row.tokenFingerprint as DeviceTokenFingerprint,
  }));
}
