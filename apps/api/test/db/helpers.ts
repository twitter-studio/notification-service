import { env } from "cloudflare:workers";
import {
  type ApnsEnvironment,
  createDb,
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

export function testDb(): Db {
  return createDb(env.DB);
}

export type Owner = { accountId: string; installationId: string };

export const TOPIC = "com.twitter-studio.Tweetbot";

export async function newAccount(db: Db) {
  return enrollInstallation(db, {
    publicKey: unique("public-key"),
    relaySecretHash: unique("secret-hash"),
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
): Promise<DeviceRegistrationResult> {
  return registerDeviceToken(db, {
    accountId: owner.accountId,
    installationId: owner.installationId,
    apnsTokenCiphertext: ciphertextOf(token),
    tokenFingerprint: fingerprintOf(token),
    apnsEnvironment,
    topic: TOPIC,
  });
}

/** 登録できたときの端末の ID。できなかったらテストを失敗にする。 */
export function deviceIdOf(result: DeviceRegistrationResult): string {
  if (result.kind !== "registered") throw new Error(`expected registered, got ${result.kind}`);
  return result.deviceId;
}

/** 登録して、トークンを持っていることを確かめた端末にする (送り先になる)。 */
export async function registerVerified(db: Db, owner: Owner, token: string): Promise<string> {
  const deviceId = deviceIdOf(await registerToken(db, owner, token));
  if (
    !(await markDeviceVerified(db, {
      accountId: owner.accountId,
      deviceId,
      tokenFingerprint: fingerprintOf(token),
      apnsEnvironment: "sandbox",
      topic: TOPIC,
    }))
  ) {
    throw new Error("markDeviceVerified failed");
  }
  return deviceId;
}
