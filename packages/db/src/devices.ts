import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db";
import { devices, installations, notificationAccounts } from "./schema";
import { toDbTime } from "./time";

export type ApnsEnvironment = "sandbox" | "production";

export type DeviceRegistration = {
  installationId: string;
  apnsTokenCiphertext: string;
  tokenFingerprint: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

export type ActiveDevice = {
  id: string;
  apnsTokenCiphertext: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

/**
 * 端末 (APNs のトークン) を登録する。同じトークン (同じ環境と topic) がすでにあれば、そのトークンを登録したインストールに移し、有効に戻す。
 * 戻り値は端末の ID。
 */
export async function upsertDevice(
  db: Db,
  input: DeviceRegistration,
  now = new Date(),
): Promise<string> {
  // 同じトークンを別のインストールが出してきたら、新しいほうに移す。APNs のトークンは端末のアプリの入れ直しで引き継がれ、
  // 出してきたインストールがその端末で APNs から受け取ったものなので、古いインストールに残すと、消したはずのアプリに届くため。
  const updatedAt = toDbTime(now);
  const rows = await db
    .insert(devices)
    .values({ id: crypto.randomUUID(), ...input, enabled: true, updatedAt })
    .onConflictDoUpdate({
      target: [devices.tokenFingerprint, devices.apnsEnvironment, devices.topic],
      set: {
        installationId: input.installationId,
        apnsTokenCiphertext: input.apnsTokenCiphertext,
        enabled: true,
        updatedAt,
      },
    })
    .returning({ id: devices.id });
  const row = rows[0];
  if (row === undefined) throw new Error("upsertDevice returned no row");
  return row.id;
}

/** アカウントの端末を止める。ほかのアカウントの端末なら何もせず false を返す。 */
export async function disableDevice(
  db: Db,
  input: { accountId: string; deviceId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ enabled: false, updatedAt: toDbTime(now) })
    .where(
      and(
        eq(devices.id, input.deviceId),
        inArray(
          devices.installationId,
          db
            .select({ id: installations.id })
            .from(installations)
            .where(eq(installations.accountId, input.accountId)),
        ),
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
        eq(devices.enabled, true),
      ),
    );
}
