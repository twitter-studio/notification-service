import { env } from "cloudflare:workers";
import {
  disableDeviceByUser,
  enableDeviceByUser,
  invalidateDevice,
  listActiveDevices,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { deviceIdOf, newAccount, registerToken, testDb, unique } from "./helpers";

describe("端末の登録", () => {
  it("アカウントの有効な端末だけを、送り先として返す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceDevice = deviceIdOf(await registerToken(db, alice, unique("token")));
    deviceIdOf(await registerToken(db, bob, unique("token")));

    const devices = await listActiveDevices(db, alice.accountId);

    expect(devices.map((device) => device.id)).toEqual([aliceDevice]);
  });

  it("同じトークンを登録し直しても、端末は 1 つのまま", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");

    const first = deviceIdOf(await registerToken(db, alice, token));
    const retried = deviceIdOf(await registerToken(db, alice, token));

    expect(retried).toBe(first);
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("トークンが変わったら、同じ端末のトークンを書き換え、古いトークンには送らない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const first = deviceIdOf(await registerToken(db, alice, unique("old-token")));
    const newToken = unique("new-token");

    const rotated = deviceIdOf(await registerToken(db, alice, newToken));

    expect(rotated).toBe(first);
    expect(
      (await listActiveDevices(db, alice.accountId)).map((device) => device.tokenFingerprint),
    ).toEqual([`fingerprint-of-${newToken}`]);
  });

  it("ほかのインストールが持つトークンは、移さずに conflict にする", async () => {
    const db = testDb();
    const victim = await newAccount(db);
    const attacker = await newAccount(db);
    const token = unique("token");
    const victimDevice = deviceIdOf(await registerToken(db, victim, token));

    expect(await registerToken(db, attacker, token)).toEqual({ kind: "conflict" });

    expect((await listActiveDevices(db, victim.accountId)).map((device) => device.id)).toEqual([
      victimDevice,
    ]);
    expect(await listActiveDevices(db, attacker.accountId)).toEqual([]);
  });

  it("ほかのアカウントのインストール、取り消したインストール、止めたアカウントには登録しない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const revoked = await newAccount(db);
    const disabled = await newAccount(db);
    await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), revoked.installationId)
      .run();
    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(disabled.accountId)
      .run();

    expect(
      await registerToken(
        db,
        { accountId: bob.accountId, installationId: alice.installationId },
        unique("token"),
      ),
    ).toEqual({ kind: "rejected" });
    expect(await registerToken(db, revoked, unique("token"))).toEqual({ kind: "rejected" });
    expect(await registerToken(db, disabled, unique("token"))).toEqual({ kind: "rejected" });
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);
  });

  it("同じトークンでも、sandbox と production は別のトークンとして扱う", async () => {
    const db = testDb();
    const sandbox = await newAccount(db);
    const production = await newAccount(db);
    const token = unique("token");

    deviceIdOf(await registerToken(db, sandbox, token, "sandbox"));

    expect((await registerToken(db, production, token, "production")).kind).toBe("registered");
  });
});

describe("端末の状態", () => {
  it("止められるのは自分のアカウントの端末だけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceDevice = deviceIdOf(await registerToken(db, alice, unique("token")));

    expect(await disableDeviceByUser(db, { accountId: bob.accountId, deviceId: aliceDevice })).toBe(
      false,
    );
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);

    expect(
      await disableDeviceByUser(db, { accountId: alice.accountId, deviceId: aliceDevice }),
    ).toBe(true);
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);
  });

  it("利用者が止めた端末は、トークンを登録し直しても止めたまま。利用者が戻すと送る", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const device = deviceIdOf(await registerToken(db, alice, token));
    await disableDeviceByUser(db, { accountId: alice.accountId, deviceId: device });

    deviceIdOf(await registerToken(db, alice, token));
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);

    expect(await enableDeviceByUser(db, { accountId: alice.accountId, deviceId: device })).toBe(
      true,
    );
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("APNs が無効と返した端末は止め、トークンを登録し直すと送る", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const device = deviceIdOf(await registerToken(db, alice, token));

    expect(
      await invalidateDevice(db, { deviceId: device, tokenFingerprint: `fingerprint-of-${token}` }),
    ).toBe(true);
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);

    deviceIdOf(await registerToken(db, alice, token));
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("送った後にトークンが入れ替わっていたら、APNs の無効の応答で新しいトークンを止めない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const oldToken = unique("old-token");
    const device = deviceIdOf(await registerToken(db, alice, oldToken));
    deviceIdOf(await registerToken(db, alice, unique("new-token")));

    expect(
      await invalidateDevice(db, {
        deviceId: device,
        tokenFingerprint: `fingerprint-of-${oldToken}`,
      }),
    ).toBe(false);
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });
});
