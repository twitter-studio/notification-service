import { env } from "cloudflare:workers";
import {
  disableDeviceByUser,
  enableDeviceByUser,
  invalidateDevice,
  listActiveDevices,
  markDeviceVerified,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import {
  deviceIdOf,
  fingerprintOf,
  newAccount,
  registerToken,
  registerVerified,
  testDb,
  unique,
} from "./helpers";

describe("端末の登録", () => {
  it("トークンを持っていることを確かめるまで、送り先にしない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const device = deviceIdOf(await registerToken(db, alice, token));

    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);

    await markDeviceVerified(db, {
      accountId: alice.accountId,
      deviceId: device,
      tokenFingerprint: fingerprintOf(token),
    });
    expect((await listActiveDevices(db, alice.accountId)).map((d) => d.id)).toEqual([device]);
  });

  it("確かめを記録できるのは、自分のアカウントの端末の、今のトークンだけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const token = unique("token");
    const device = deviceIdOf(await registerToken(db, alice, token));

    expect(
      await markDeviceVerified(db, {
        accountId: bob.accountId,
        deviceId: device,
        tokenFingerprint: fingerprintOf(token),
      }),
    ).toBe(false);
    expect(
      await markDeviceVerified(db, {
        accountId: alice.accountId,
        deviceId: device,
        tokenFingerprint: "other",
      }),
    ).toBe(false);
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);
  });

  it("アカウントの有効な端末だけを、送り先として返す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const aliceDevice = await registerVerified(db, alice, unique("token"));
    await registerVerified(db, bob, unique("token"));

    expect((await listActiveDevices(db, alice.accountId)).map((d) => d.id)).toEqual([aliceDevice]);
  });

  it("同じトークンを登録し直しても、端末は 1 つのままで、確かめも残る", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const first = await registerVerified(db, alice, token);

    expect(deviceIdOf(await registerToken(db, alice, token))).toBe(first);
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("トークンが変わったら、同じ端末を書き換え、確かめ直すまで送らない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const first = await registerVerified(db, alice, unique("old-token"));
    const newToken = unique("new-token");

    expect(deviceIdOf(await registerToken(db, alice, newToken))).toBe(first);
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);

    await markDeviceVerified(db, {
      accountId: alice.accountId,
      deviceId: first,
      tokenFingerprint: fingerprintOf(newToken),
    });
    expect((await listActiveDevices(db, alice.accountId)).map((d) => d.tokenFingerprint)).toEqual([
      fingerprintOf(newToken),
    ]);
  });

  it("確かめた有効な端末のトークンは、ほかのインストールに移さず conflict にする", async () => {
    const db = testDb();
    const victim = await newAccount(db);
    const attacker = await newAccount(db);
    const token = unique("token");
    const victimDevice = await registerVerified(db, victim, token);

    expect(await registerToken(db, attacker, token)).toEqual({ kind: "conflict" });

    expect((await listActiveDevices(db, victim.accountId)).map((d) => d.id)).toEqual([
      victimDevice,
    ]);
    expect(await listActiveDevices(db, attacker.accountId)).toEqual([]);
  });

  it("確かめていない先取りは、本物の端末の登録に譲り、先取りした側には送らない", async () => {
    const db = testDb();
    const attacker = await newAccount(db);
    const owner = await newAccount(db);
    const token = unique("token");
    deviceIdOf(await registerToken(db, attacker, token));

    const ownerDevice = await registerVerified(db, owner, token);

    expect((await listActiveDevices(db, owner.accountId)).map((d) => d.id)).toEqual([ownerDevice]);
    expect(await listActiveDevices(db, attacker.accountId)).toEqual([]);
  });

  it("取り消したインストール、有効でないアカウント、APNs が無効と返した端末のトークンは、新しい登録に譲る", async () => {
    const db = testDb();
    for (const makeStale of [
      async (owner: { installationId: string }) =>
        env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
          .bind(Date.now(), owner.installationId)
          .run(),
      async (owner: { accountId: string }) =>
        env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
          .bind(owner.accountId)
          .run(),
      async (owner: { accountId: string }) =>
        env.DB.prepare("UPDATE notification_accounts SET state = 'deleted' WHERE id = ?")
          .bind(owner.accountId)
          .run(),
      async (_owner: unknown, deviceId: string, token: string) =>
        invalidateDevice(db, { deviceId, tokenFingerprint: fingerprintOf(token) }),
    ]) {
      const before = await newAccount(db);
      const after = await newAccount(db);
      const token = unique("token");
      const old = await registerVerified(db, before, token);
      await makeStale(before, old, token);

      expect((await registerToken(db, after, token)).kind).toBe("registered");
    }
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
  });

  it("登録できない呼び出しは、ほかのインストールの確かめていない行を消さない", async () => {
    const db = testDb();
    const holder = await newAccount(db);
    const revoked = await newAccount(db);
    const token = unique("token");
    const held = deviceIdOf(await registerToken(db, holder, token));
    await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
      .bind(Date.now(), revoked.installationId)
      .run();

    expect(await registerToken(db, revoked, token)).toEqual({ kind: "rejected" });

    const row = await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(held).first();
    expect(row).not.toBeNull();
  });

  it("同じトークンでも、sandbox と production は別のトークンとして扱う", async () => {
    const db = testDb();
    const sandbox = await newAccount(db);
    const production = await newAccount(db);
    const token = unique("token");
    await registerVerified(db, sandbox, token);

    expect((await registerToken(db, production, token, "production")).kind).toBe("registered");
  });
});

describe("端末の状態", () => {
  it("止めたり戻したりできるのは、自分のアカウントの端末だけ", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const device = await registerVerified(db, alice, unique("token"));

    expect(await disableDeviceByUser(db, { accountId: bob.accountId, deviceId: device })).toBe(
      false,
    );
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);

    expect(await disableDeviceByUser(db, { accountId: alice.accountId, deviceId: device })).toBe(
      true,
    );
    expect(await enableDeviceByUser(db, { accountId: bob.accountId, deviceId: device })).toBe(
      false,
    );
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);
  });

  it("利用者が止めた端末は、トークンを登録し直しても止めたまま。利用者が戻すと送る", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const device = await registerVerified(db, alice, token);
    await disableDeviceByUser(db, { accountId: alice.accountId, deviceId: device });

    deviceIdOf(await registerToken(db, alice, token));
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);

    expect(await enableDeviceByUser(db, { accountId: alice.accountId, deviceId: device })).toBe(
      true,
    );
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("APNs が無効と返した端末は止め、同じインストールがトークンを登録し直すと送る", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const device = await registerVerified(db, alice, token);

    expect(
      await invalidateDevice(db, { deviceId: device, tokenFingerprint: fingerprintOf(token) }),
    ).toBe(true);
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);

    deviceIdOf(await registerToken(db, alice, token));
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });

  it("送った後にトークンが入れ替わっていたら、APNs の無効の応答で新しいトークンを止めない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const oldToken = unique("old-token");
    const device = await registerVerified(db, alice, oldToken);
    const newToken = unique("new-token");
    deviceIdOf(await registerToken(db, alice, newToken));
    await markDeviceVerified(db, {
      accountId: alice.accountId,
      deviceId: device,
      tokenFingerprint: fingerprintOf(newToken),
    });

    expect(
      await invalidateDevice(db, { deviceId: device, tokenFingerprint: fingerprintOf(oldToken) }),
    ).toBe(false);
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });
});
