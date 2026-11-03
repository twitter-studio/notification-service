import { env } from "cloudflare:workers";
import {
  type ApnsEnvironment,
  type BearerTokenHash,
  createDb,
  createDeviceVerification,
  type Db,
  type DeviceRegistrationResult,
  type DeviceTokenCiphertext,
  type DeviceTokenFingerprint,
  enrollInstallation,
  markDeviceVerified,
  registerDeviceToken,
} from "@notification-service/db";

/** テストごとに違う値。テストの D1 はテストどうしで空にならないので、ID、ハッシュ、トークンがぶつからないようにする。 */
export function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** テストのトークンのハッシュ (DB の CHECK に合う 43 文字の Base64URL)。テストごとに違う値にする。 */
export function testHash(): BearerTokenHash {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "") as BearerTokenHash;
}

export function testDb(): Db {
  return createDb(env.DB);
}

export type Owner = { accountId: string; installationId: string };

export const TOPIC = "com.twitter-studio.Tweetbot";

/** 署名に使ったものとして記録するチャレンジ (DB のテストでは、署名は確かめない)。 */
export function consumedChallenge() {
  return { nonce: unique("nonce"), expiresAt: new Date(Date.now() + 5 * 60 * 1000) };
}

export async function newAccount(db: Db) {
  return enrollInstallation(db, {
    publicKey: unique("public-key"),
    relaySecretHash: testHash(),
    challenge: consumedChallenge(),
  });
}

/** DB のテスト用の指紋と暗号文。DB の CHECK に合う形にする。本物の暗号化は test/security で確かめる。 */
export function fingerprintOf(token: string): DeviceTokenFingerprint {
  return `f1.fingerprint-of-${token}` as DeviceTokenFingerprint;
}

function ciphertextOf(token: string): DeviceTokenCiphertext {
  return `v1.test.ciphertext-of-${token}` as DeviceTokenCiphertext;
}

export async function registerToken(
  db: Db,
  owner: Owner,
  token: string,
  apnsEnvironment: ApnsEnvironment = "sandbox",
  topic = TOPIC,
): Promise<DeviceRegistrationResult> {
  return registerDeviceToken(db, {
    accountId: owner.accountId,
    installationId: owner.installationId,
    apnsTokenCiphertext: ciphertextOf(token),
    tokenFingerprint: fingerprintOf(token),
    apnsEnvironment,
    topic,
    challenge: consumedChallenge(),
  });
}

/**
 * 端末の今のトークンへ code を送ったものとして確かめの記録を置き、その code のハッシュを返す。置けなければ undefined。
 * 送る先のトークンを、端末の行から読む (API は要求のトークンを使う。ここでは DB の関数だけを確かめる)。
 */
export async function issueVerification(
  db: Db,
  owner: Owner,
  deviceId: string,
  expiresAt = new Date(Date.now() + 10 * 60 * 1000),
): Promise<BearerTokenHash | undefined> {
  const row = await env.DB.prepare(
    "SELECT token_fingerprint, apns_environment, topic FROM devices WHERE id = ?",
  )
    .bind(deviceId)
    .first<{ token_fingerprint: string; apns_environment: ApnsEnvironment; topic: string }>();
  const codeHash = testHash();
  const created = await createDeviceVerification(db, {
    accountId: owner.accountId,
    deviceId,
    codeHash,
    expiresAt,
    tokenFingerprint: (row?.token_fingerprint ?? "f1.none") as DeviceTokenFingerprint,
    apnsEnvironment: row?.apns_environment ?? "sandbox",
    topic: row?.topic ?? TOPIC,
  });
  return created ? codeHash : undefined;
}

/** 確かめの記録を置いて、アプリが code を返したところまで行う。確かめられたら true。 */
export async function verifyDevice(db: Db, owner: Owner, deviceId: string): Promise<boolean> {
  const codeHash = (await issueVerification(db, owner, deviceId)) ?? testHash();
  return markDeviceVerified(db, { accountId: owner.accountId, deviceId, codeHash });
}

/** 登録できたときの端末の ID。できなかったらテストを失敗にする。 */
export function deviceIdOf(result: DeviceRegistrationResult): string {
  if (result.kind !== "registered") throw new Error(`expected registered, got ${result.kind}`);
  return result.deviceId;
}

/** 登録して、トークンを持っていることを確かめた端末にする (送り先になる)。 */
export async function registerVerified(db: Db, owner: Owner, token: string): Promise<string> {
  const deviceId = deviceIdOf(await registerToken(db, owner, token));
  if (!(await verifyDevice(db, owner, deviceId))) throw new Error("verifyDevice failed");
  return deviceId;
}
