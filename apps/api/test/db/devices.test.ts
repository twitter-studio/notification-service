import { env } from "cloudflare:workers";
import { disableDevice, listActiveDevices } from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { newAccount, registerDevice, testDb, unique } from "./helpers";

describe("端末", () => {
  it("アカウントの有効な端末だけを、送り先として返す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceDevice = await registerDevice(db, alice.installationId, unique("alice-token"));
    await registerDevice(db, bob.installationId, unique("bob-token"));

    const devices = await listActiveDevices(db, alice.accountId);

    expect(devices.map((device) => device.id)).toEqual([aliceDevice]);
  });

  it("同じトークンを登録し直しても、端末は 1 つのまま", async () => {
    const db = testDb();
    const token = unique("token");
    const alice = await newAccount(db);

    const first = await registerDevice(db, alice.installationId, token);
    const retried = await registerDevice(db, alice.installationId, token);

    expect(retried).toBe(first);
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("同じトークンを別のインストールが登録すると、新しいほうに移る", async () => {
    const db = testDb();
    const token = unique("token");
    const before = await newAccount(db);
    const reinstalled = await newAccount(db);
    await registerDevice(db, before.installationId, token);

    await registerDevice(db, reinstalled.installationId, token);

    expect(await listActiveDevices(db, before.accountId)).toEqual([]);
    expect(await listActiveDevices(db, reinstalled.accountId)).toHaveLength(1);
  });

  it("同じトークンでも、sandbox と production は別の端末", async () => {
    const db = testDb();
    const token = unique("token");
    const alice = await newAccount(db);

    await registerDevice(db, alice.installationId, token, "sandbox");
    await registerDevice(db, alice.installationId, token, "production");

    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(2);
  });

  it("ほかのアカウントの端末は止められない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceDevice = await registerDevice(db, alice.installationId, unique("alice-token"));

    expect(await disableDevice(db, { accountId: bob.accountId, deviceId: aliceDevice })).toBe(
      false,
    );
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);

    expect(await disableDevice(db, { accountId: alice.accountId, deviceId: aliceDevice })).toBe(
      true,
    );
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);
  });

  it("止めたアカウントと、取り消したインストールの端末には送らない", async () => {
    const db = testDb();
    const disabled = await newAccount(db);
    const revoked = await newAccount(db);
    await registerDevice(db, disabled.installationId, unique("token-1"));
    await registerDevice(db, revoked.installationId, unique("token-2"));

    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(disabled.accountId)
      .run();
    await env.DB.prepare(
      "UPDATE installations SET revoked_at = '2026-11-04T00:00:00.000Z' WHERE id = ?",
    )
      .bind(revoked.installationId)
      .run();

    expect(await listActiveDevices(db, disabled.accountId)).toEqual([]);
    expect(await listActiveDevices(db, revoked.accountId)).toEqual([]);
  });
});
