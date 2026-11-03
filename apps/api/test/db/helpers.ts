import { env } from "cloudflare:workers";
import {
  type ApnsEnvironment,
  createAccountWithInstallation,
  createDb,
  type Db,
  upsertDevice,
} from "@notification-service/db";

/** テストごとに違う値。テストの D1 はテストどうしで空にならないので、ID やハッシュがぶつからないようにする。 */
export function unique(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function testDb(): Db {
  return createDb(env.DB);
}

export async function registerDevice(
  db: Db,
  installationId: string,
  token: string,
  apnsEnvironment: ApnsEnvironment = "sandbox",
) {
  return upsertDevice(db, {
    installationId,
    apnsTokenCiphertext: `ciphertext-of-${token}`,
    tokenFingerprint: `fingerprint-of-${token}`,
    apnsEnvironment,
    topic: "com.twitter-studio.Tweetbot",
  });
}

export async function newAccount(db: Db) {
  return createAccountWithInstallation(db, { publicKey: "test-public-key" });
}
