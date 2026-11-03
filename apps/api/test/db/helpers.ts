import { env } from "cloudflare:workers";
import {
  type ApnsEnvironment,
  createDb,
  type Db,
  type DeviceRegistrationResult,
  enrollInstallation,
  registerDeviceToken,
} from "@notification-service/db";

/** テストごとに違う値。テストの D1 はテストどうしで空にならないので、ID、ハッシュ、トークンがぶつからないようにする。 */
export function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function testDb(): Db {
  return createDb(env.DB);
}

export async function newAccount(db: Db) {
  return enrollInstallation(db, {
    publicKey: unique("public-key"),
    relaySecretHash: unique("secret-hash"),
  });
}

export async function registerToken(
  db: Db,
  owner: { accountId: string; installationId: string },
  token: string,
  apnsEnvironment: ApnsEnvironment = "sandbox",
): Promise<DeviceRegistrationResult> {
  return registerDeviceToken(db, {
    accountId: owner.accountId,
    installationId: owner.installationId,
    apnsTokenCiphertext: `ciphertext-of-${token}`,
    tokenFingerprint: `fingerprint-of-${token}`,
    apnsEnvironment,
    topic: "com.twitter-studio.Tweetbot",
  });
}

/** 登録できたときの端末の ID。できなかったらテストを失敗にする。 */
export function deviceIdOf(result: DeviceRegistrationResult): string {
  if (result.kind !== "registered") throw new Error(`expected registered, got ${result.kind}`);
  return result.deviceId;
}
