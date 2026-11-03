import { env } from "cloudflare:workers";
import {
  type BearerTokenHash,
  createDeviceVerification,
  type DeviceTokenFingerprint,
  deleteAccount,
  deleteExpiredDeviceVerifications,
  disableDeviceByUser,
  enableDeviceByUser,
  invalidateDevice,
  listActiveDevices,
  markDeviceVerified,
  revokeInstallation,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import {
  deviceIdOf,
  fingerprintOf,
  issueVerification,
  newAccount,
  type Owner,
  registerToken,
  registerVerified,
  TOPIC,
  testDb,
  testHash,
  unique,
  verifyDevice,
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

    expect(await verifyDevice(db, alice, device)).toBe(true);
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

    expect(await verifyDevice(db, alice, first)).toBe(true);
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

    expect(await verifyDevice(db, owner, ownerDevice)).toBe(true);
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
    // ほかのアカウントの端末には、確かめの記録も置けない。
    expect(await issueVerification(db, holder, strangerDevice)).toBeUndefined();
    const strangerCode = await issueVerification(db, stranger, strangerDevice);
    expect(
      await markDeviceVerified(db, {
        accountId: holder.accountId,
        deviceId: strangerDevice,
        codeHash: strangerCode ?? testHash(),
      }),
    ).toBe(false);
    // 確かめの記録を置いた後に、トークンが変わった。
    const changed = await issueVerification(db, stranger, strangerDevice);
    await registerToken(db, stranger, unique("other"));
    expect(
      await markDeviceVerified(db, {
        accountId: stranger.accountId,
        deviceId: strangerDevice,
        codeHash: changed ?? testHash(),
      }),
    ).toBe(false);
    for (const makeInvalid of [revoke, (owner: Owner) => setAccountState(owner, "disabled")]) {
      const other = await newAccount(db);
      const otherDevice = deviceIdOf(await registerToken(db, other, token));
      const code = await issueVerification(db, other, otherDevice);
      await makeInvalid(other);

      expect(
        await markDeviceVerified(db, {
          accountId: other.accountId,
          deviceId: otherDevice,
          codeHash: code ?? testHash(),
        }),
      ).toBe(false);
    }

    expect((await listActiveDevices(db, holder.accountId)).map((d) => d.id)).toEqual([
      holderDevice,
    ]);
  });

  it("確かめは、記録を置いたときのトークンの指紋、環境、topic が、今の端末と合うときだけ記録する", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const device = deviceIdOf(await registerToken(db, alice, token));

    for (const [apnsEnvironment, topic] of [
      ["production", TOPIC],
      ["sandbox", "other.topic"],
    ] as const) {
      await registerToken(db, alice, token);
      const codeHash = await issueVerification(db, alice, device);
      await registerToken(db, alice, token, apnsEnvironment, topic);

      expect(
        await markDeviceVerified(db, {
          accountId: alice.accountId,
          deviceId: device,
          codeHash: codeHash ?? testHash(),
        }),
      ).toBe(false);
    }
    expect(await listActiveDevices(db, alice.accountId)).toEqual([]);
  });

  it("違う code、期限を過ぎた code、使った code では確かめられない", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const device = deviceIdOf(await registerToken(db, alice, unique("token")));
    const mark = (codeHash: BearerTokenHash | undefined) =>
      markDeviceVerified(db, {
        accountId: alice.accountId,
        deviceId: device,
        codeHash: codeHash ?? testHash(),
      });

    await issueVerification(db, alice, device);
    expect(await mark(testHash())).toBe(false);
    const expired = await issueVerification(db, alice, device, new Date(Date.now() - 1));
    expect(await mark(expired)).toBe(false);
    // 期限を過ぎた code も、合った記録は消す。
    const left = await env.DB.prepare(
      "SELECT count(*) AS count FROM device_verifications WHERE device_id = ?",
    )
      .bind(device)
      .first<{ count: number }>();
    expect(left?.count).toBe(0);

    const valid = await issueVerification(db, alice, device);
    expect(await mark(valid)).toBe(true);
    await registerToken(db, alice, unique("token"));
    expect(await mark(valid)).toBe(false);
  });

  it("新しく置いた確かめの記録は、前の code を置き換える", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const device = deviceIdOf(await registerToken(db, alice, unique("token")));
    const first = await issueVerification(db, alice, device);
    const second = await issueVerification(db, alice, device);

    expect(
      await markDeviceVerified(db, {
        accountId: alice.accountId,
        deviceId: device,
        codeHash: first ?? testHash(),
      }),
    ).toBe(false);
    expect(
      await markDeviceVerified(db, {
        accountId: alice.accountId,
        deviceId: device,
        codeHash: second ?? testHash(),
      }),
    ).toBe(true);
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
    await verifyDevice(db, alice, device);

    expect(
      await invalidateDevice(db, { deviceId: device, tokenFingerprint: fingerprintOf(oldToken) }),
    ).toBe(false);
    expect(await listActiveDevices(db, alice.accountId)).toHaveLength(1);
  });
});

describe("端末の確かめの記録", () => {
  it("期限を過ぎた記録だけを消す", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const bob = await newAccount(db);
    const before = new Date("2001-01-01T00:00:00.000Z");
    const expired = deviceIdOf(await registerToken(db, alice, unique("token")));
    const pending = deviceIdOf(await registerToken(db, bob, unique("token")));
    await issueVerification(db, alice, expired, new Date(before.getTime() - 1));
    await issueVerification(db, bob, pending, before);

    await deleteExpiredDeviceVerifications(db, before);

    const rows = await env.DB.prepare(
      "SELECT device_id FROM device_verifications WHERE device_id IN (?, ?)",
    )
      .bind(expired, pending)
      .all<{ device_id: string }>();
    expect(rows.results.map((row) => row.device_id)).toEqual([pending]);
  });

  it("確かめの途中でも、インストールの取り消しとアカウントの削除で、記録と端末を消せる", async () => {
    const db = testDb();
    const revoked = await newAccount(db);
    const deleted = await newAccount(db);
    const devices = [
      deviceIdOf(await registerToken(db, revoked, unique("token"))),
      deviceIdOf(await registerToken(db, deleted, unique("token"))),
    ];
    await issueVerification(db, revoked, devices[0] ?? "");
    await issueVerification(db, deleted, devices[1] ?? "");

    expect(await revokeInstallation(db, revoked)).toBe(true);
    expect(await deleteAccount(db, { accountId: deleted.accountId })).toBe(true);

    for (const table of ["device_verifications", "devices"]) {
      const column = table === "devices" ? "id" : "device_id";
      const row = await env.DB.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE ${column} IN (?, ?)`,
      )
        .bind(...devices)
        .first<{ count: number }>();
      expect(row?.count, table).toBe(0);
    }
  });

  it("記録は、送る先のトークンが今の端末のトークンで、まだ確かめていないときだけ置く", async () => {
    const db = testDb();
    const alice = await newAccount(db);
    const token = unique("token");
    const device = deviceIdOf(await registerToken(db, alice, token));
    const place = (
      tokenFingerprint: DeviceTokenFingerprint,
      apnsEnvironment: "sandbox" | "production" = "sandbox",
    ) =>
      createDeviceVerification(db, {
        accountId: alice.accountId,
        deviceId: device,
        codeHash: testHash(),
        expiresAt: new Date(Date.now() + 60_000),
        tokenFingerprint,
        apnsEnvironment,
        topic: TOPIC,
      });

    expect(await place(fingerprintOf(unique("other")))).toBe(false);
    expect(await place(fingerprintOf(token), "production")).toBe(false);
    expect(await place(fingerprintOf(token))).toBe(true);
    await verifyDevice(db, alice, device);
    expect(await place(fingerprintOf(token))).toBe(false);
  });
});
