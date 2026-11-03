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
  type Owner,
  registerToken,
  registerVerified,
  testDb,
  unique,
} from "./helpers";

async function revoke(owner: Owner) {
  await env.DB.prepare("UPDATE installations SET revoked_at = ? WHERE id = ?")
    .bind(Date.now(), owner.installationId)
    .run();
}

async function setAccountState(owner: Owner, state: string) {
  await env.DB.prepare("UPDATE notification_accounts SET state = ? WHERE id = ?")
    .bind(state, owner.accountId)
    .run();
}

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

  it("同じトークンの確かめていない登録は何行あってもよく、どれにも送らない", async () => {
    const db = testDb();
    const first = await newAccount(db);
    const second = await newAccount(db);
    const token = unique("token");

    const results = await Promise.all([
      registerToken(db, first, token),
      registerToken(db, second, token),
    ]);

    for (const result of results) {
      expect(
        await env.DB.prepare("SELECT id FROM devices WHERE id = ?")
          .bind(deviceIdOf(result))
          .first(),
      ).not.toBeNull();
    }
    expect(await listActiveDevices(db, first.accountId)).toEqual([]);
    expect(await listActiveDevices(db, second.accountId)).toEqual([]);
  });

  it("ほかのアカウントが同じトークンを登録しても、自分の行と止めた設定には触れない", async () => {
    const db = testDb();
    const owner = await newAccount(db);
    const attacker = await newAccount(db);
    const token = unique("token");
    const ownerDevice = deviceIdOf(await registerToken(db, owner, token));
    await disableDeviceByUser(db, { accountId: owner.accountId, deviceId: ownerDevice });

    deviceIdOf(await registerToken(db, attacker, token));

    const row = await env.DB.prepare("SELECT state FROM devices WHERE id = ?")
      .bind(ownerDevice)
      .first<{ state: string }>();
    expect(row?.state).toBe("disabled_by_user");
  });

  it("確かめた行があっても、トークンを確かめた側が引き継ぎ、前の持ち主には送らない", async () => {
    const db = testDb();
    const before = await newAccount(db);
    const after = await newAccount(db);
    const token = unique("token");
    await registerVerified(db, before, token);

    const afterDevice = await registerVerified(db, after, token);

    expect((await listActiveDevices(db, after.accountId)).map((d) => d.id)).toEqual([afterDevice]);
    expect(await listActiveDevices(db, before.accountId)).toEqual([]);
  });

  it("先取りした登録は送り先にならず、くり返されても本物の端末の確かめを妨げない", async () => {
    const db = testDb();
    const owner = await newAccount(db);
    const attacker = await newAccount(db);
    const token = unique("token");
    const ownerDevice = deviceIdOf(await registerToken(db, owner, token));

    for (let i = 0; i < 3; i++) deviceIdOf(await registerToken(db, attacker, token));

    expect(
      await markDeviceVerified(db, {
        accountId: owner.accountId,
        deviceId: ownerDevice,
        tokenFingerprint: fingerprintOf(token),
      }),
    ).toBe(true);
    expect((await listActiveDevices(db, owner.accountId)).map((d) => d.id)).toEqual([ownerDevice]);
    expect(await listActiveDevices(db, attacker.accountId)).toEqual([]);
  });

  it("確かめられないとき (ほかのアカウント、今と違うトークン、取り消したインストール、有効でないアカウント) は、何も変えない", async () => {
    const db = testDb();
    const holder = await newAccount(db);
    const token = unique("token");
    const holderDevice = await registerVerified(db, holder, token);

    const stranger = await newAccount(db);
    const strangerDevice = deviceIdOf(await registerToken(db, stranger, token));
    expect(
      await markDeviceVerified(db, {
        accountId: holder.accountId,
        deviceId: strangerDevice,
        tokenFingerprint: fingerprintOf(token),
      }),
    ).toBe(false);
    expect(
      await markDeviceVerified(db, {
        accountId: stranger.accountId,
        deviceId: strangerDevice,
        tokenFingerprint: "other",
      }),
    ).toBe(false);
    for (const makeInvalid of [revoke, (owner: Owner) => setAccountState(owner, "disabled")]) {
      const other = await newAccount(db);
      const otherDevice = deviceIdOf(await registerToken(db, other, token));
      await makeInvalid(other);

      expect(
        await markDeviceVerified(db, {
          accountId: other.accountId,
          deviceId: otherDevice,
          tokenFingerprint: fingerprintOf(token),
        }),
      ).toBe(false);
    }

    expect((await listActiveDevices(db, holder.accountId)).map((d) => d.id)).toEqual([
      holderDevice,
    ]);
  });

  it("ほかのアカウントのインストール、取り消したインストール、止めたアカウントには登録しない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const revoked = await newAccount(db);
    const disabled = await newAccount(db);
    await revoke(revoked);
    await setAccountState(disabled, "disabled");

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

  it("同じトークンでも、sandbox と production は別のトークンとして扱う", async () => {
    const db = testDb();
    const sandbox = await newAccount(db);
    const production = await newAccount(db);
    const token = unique("token");
    await registerVerified(db, sandbox, token);

    expect((await registerToken(db, production, token, "production")).kind).toBe("registered");
    expect(await listActiveDevices(db, sandbox.accountId)).toHaveLength(1);
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
