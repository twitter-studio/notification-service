import { env } from "cloudflare:workers";
import { createDb, listActiveDevices } from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { DeviceVerificationPush } from "../src/devices/verification";
import { deviceMessage, sessionMessage } from "../src/security/installation-key";
import {
  call,
  type DeviceKey,
  type Enrolled,
  enrollNewDevice,
  expectProblem,
  issueTestChallenge,
} from "./helpers/api";
import { newDeviceKey } from "./helpers/device-key";
import { jsonHeaders } from "./helpers/http";
import { expectLimitReached, outcomeOf } from "./helpers/rate-limit";

const TOPIC = "com.twitter-studio.Tweetbot";

function newApnsToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** 確かめの push を、送らずに記録する app。 */
function appWithPushes() {
  const pushes: DeviceVerificationPush[] = [];
  const app = createApp({
    sendDeviceVerification: async (push) => {
      pushes.push(push);
      return true;
    },
  });
  return { app, pushes };
}

type App = ReturnType<typeof createApp>;

async function request(
  app: App,
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
) {
  const headers = jsonHeaders();
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return app.request(
    `https://notification.test${path}`,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
  );
}

type DeviceInput = {
  apnsToken: string;
  apnsEnvironment?: "sandbox" | "production";
  topic?: string;
  enabled?: boolean;
};

/** 端末を登録する。`overrides` で、署名する値や送る値を変えられる。 */
async function putDevice(
  app: App,
  owner: { device: DeviceKey; enrolled: Enrolled },
  input: DeviceInput,
  overrides: {
    installationId?: string;
    challenge?: string;
    signature?: string;
    token?: string;
    signer?: DeviceKey;
  } = {},
) {
  const apnsEnvironment = input.apnsEnvironment ?? "sandbox";
  const topic = input.topic ?? TOPIC;
  const installationId = overrides.installationId ?? owner.enrolled.installation_id;
  const challenge = overrides.challenge ?? (await issueTestChallenge("device"));
  const signature =
    overrides.signature ??
    (await (overrides.signer ?? owner.device).sign(
      deviceMessage(challenge, owner.enrolled.installation_id, {
        apnsEnvironment,
        topic,
        apnsToken: input.apnsToken.toLowerCase(),
        enabled: input.enabled,
      }),
    ));
  return request(
    app,
    "PUT",
    `/v1/devices/${installationId}`,
    overrides.token ?? owner.enrolled.session.token,
    {
      apns_token: input.apnsToken,
      apns_environment: apnsEnvironment,
      topic,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      challenge,
      signature,
    },
  );
}

async function confirm(
  app: App,
  enrolled: Enrolled,
  code: string,
  installationId = enrolled.installation_id,
) {
  return request(
    app,
    "POST",
    `/v1/devices/${installationId}/verification`,
    enrolled.session.token,
    {
      code,
    },
  );
}

type DeviceResult = {
  device_id: string;
  state: string;
  verified: boolean;
  verification_sent?: boolean;
};

async function activeDeviceIds(enrolled: Enrolled) {
  return (await listActiveDevices(createDb(env.DB), enrolled.account_id)).map(
    (device) => device.id,
  );
}

describe("端末の登録", () => {
  it("登録すると確かめの push を送り、届いた code を返すと確かめて、送り先になる", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();

    const response = await putDevice(app, owner, { apnsToken });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<DeviceResult>();
    expect(body).toMatchObject({ state: "active", verified: false, verification_sent: true });
    expect(await activeDeviceIds(owner.enrolled)).toEqual([]);
    expect(pushes).toHaveLength(1);
    const [push] = pushes;
    expect(push).toMatchObject({
      deviceId: body.device_id,
      apnsToken,
      apnsEnvironment: "sandbox",
      topic: TOPIC,
    });
    expect(push?.code).toMatch(/^tsv_[A-Za-z0-9_-]{43}$/);

    const confirmed = await confirm(app, owner.enrolled, push?.code ?? "");

    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ device_id: body.device_id, verified: true });
    expect(await activeDeviceIds(owner.enrolled)).toEqual([body.device_id]);
    // DB には、トークンと code の平文を置かない。
    const rows = await env.DB.prepare("SELECT * FROM devices WHERE id = ?")
      .bind(body.device_id)
      .all();
    expect(JSON.stringify(rows.results)).not.toContain(apnsToken);
  });

  it("確かめた端末を、同じトークンで登録し直しても、確かめたままで、push は送らない", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();
    await putDevice(app, owner, { apnsToken });
    await confirm(app, owner.enrolled, pushes[0]?.code ?? "");

    const again = await (
      await putDevice(app, owner, { apnsToken: apnsToken.toUpperCase() })
    ).json<DeviceResult>();

    expect(again).toMatchObject({ verified: true, verification_sent: false });
    expect(pushes).toHaveLength(1);
  });

  it("トークンを入れ替えると、確かめ直すまで送らず、前の code では確かめられない", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    await putDevice(app, owner, { apnsToken: newApnsToken() });
    const oldCode = pushes[0]?.code ?? "";

    const rotated = await (
      await putDevice(app, owner, { apnsToken: newApnsToken() })
    ).json<DeviceResult>();

    expect(rotated).toMatchObject({ verified: false, verification_sent: true });
    await expectProblem(await confirm(app, owner.enrolled, oldCode), 422);
    expect((await confirm(app, owner.enrolled, pushes[1]?.code ?? "")).status).toBe(200);
  });

  it("ほかのアカウントの端末は、登録、確かめ、止めるのどれでも触れない (404)", async () => {
    const { app, pushes } = appWithPushes();
    const alice = await enrollNewDevice();
    const bob = await enrollNewDevice();
    await putDevice(app, bob, { apnsToken: newApnsToken() });
    await confirm(app, bob.enrolled, pushes[0]?.code ?? "");
    const bobDevices = await activeDeviceIds(bob.enrolled);

    await expectProblem(
      await putDevice(
        app,
        alice,
        { apnsToken: newApnsToken() },
        { installationId: bob.enrolled.installation_id },
      ),
      404,
    );
    await expectProblem(
      await confirm(app, alice.enrolled, "tsv_x", bob.enrolled.installation_id),
      404,
    );
    await expectProblem(
      await request(
        app,
        "DELETE",
        `/v1/devices/${bob.enrolled.installation_id}`,
        alice.enrolled.session.token,
      ),
      404,
    );
    expect(await activeDeviceIds(bob.enrolled)).toEqual(bobDevices);
  });

  it("ほかのアカウントが同じトークンを登録しても、push の code を受け取れないので、確かめた端末を奪えない", async () => {
    const { app, pushes } = appWithPushes();
    const alice = await enrollNewDevice();
    const attacker = await enrollNewDevice();
    const apnsToken = newApnsToken();
    await putDevice(app, alice, { apnsToken });
    await confirm(app, alice.enrolled, pushes[0]?.code ?? "");
    const aliceDevices = await activeDeviceIds(alice.enrolled);

    expect((await putDevice(app, attacker, { apnsToken })).status).toBe(200);
    // push は本物の端末に届く。攻撃する側は code を知らない。
    await expectProblem(await confirm(app, attacker.enrolled, pushes[0]?.code ?? ""), 422);

    expect(await activeDeviceIds(alice.enrolled)).toEqual(aliceDevices);
    expect(await activeDeviceIds(attacker.enrolled)).toEqual([]);
  });

  it("セッションがない、署名した値と違う、ほかの鍵の署名、ほかの用途のチャレンジでは登録できない", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();

    await expectProblem(await putDevice(app, owner, { apnsToken }, { token: "" }), 401);
    const challenge = await issueTestChallenge("device");
    const signedOther = await owner.device.sign(
      deviceMessage(challenge, owner.enrolled.installation_id, {
        apnsEnvironment: "sandbox",
        topic: TOPIC,
        apnsToken: newApnsToken(),
      }),
    );
    await expectProblem(
      await putDevice(app, owner, { apnsToken }, { challenge, signature: signedOther }),
      401,
    );
    await expectProblem(
      await putDevice(app, owner, { apnsToken }, { signer: await newDeviceKey() }),
      401,
    );
    await expectProblem(
      await putDevice(
        app,
        owner,
        { apnsToken },
        { challenge: await issueTestChallenge("session") },
      ),
      401,
    );
    expect(await activeDeviceIds(owner.enrolled)).toEqual([]);
  });

  it("同じチャレンジでは 2 回登録できない", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();
    const challenge = await issueTestChallenge("device");
    expect((await putDevice(app, owner, { apnsToken }, { challenge })).status).toBe(200);

    await expectProblem(await putDevice(app, owner, { apnsToken }, { challenge }), 409);
  });

  it("許していない topic、形の違うトークン、UUID でない ID は 422", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();

    await expectProblem(
      await putDevice(app, owner, { apnsToken: newApnsToken(), topic: "com.example.Other" }),
      422,
    );
    await expectProblem(await putDevice(app, owner, { apnsToken: "not-hex" }), 422);
    await expectProblem(
      await putDevice(app, owner, { apnsToken: newApnsToken() }, { installationId: "not-a-uuid" }),
      422,
    );
  });

  it("違う code では確かめられない", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    await putDevice(app, owner, { apnsToken: newApnsToken() });

    await expectProblem(await confirm(app, owner.enrolled, `tsv_${"A".repeat(43)}`), 422);
    expect(await activeDeviceIds(owner.enrolled)).toEqual([]);
  });

  it("APNs へ送る仕組みがまだないときは、push を送らず、そのことを返す", async () => {
    const owner = await enrollNewDevice();

    const response = await putDevice(createApp(), owner, { apnsToken: newApnsToken() });

    expect(await response.json()).toMatchObject({ verified: false, verification_sent: false });
  });

  it("同じトークンへの確かめの push が多すぎると、アカウントが違っても送らないが、登録は通す", async () => {
    const { app, pushes } = appWithPushes();
    const apnsToken = newApnsToken();
    await expectLimitReached(10, async () => {
      const response = await putDevice(app, await enrollNewDevice(), { apnsToken });
      expect(response.status).toBe(200);
      return (await response.json<DeviceResult>()).verification_sent ? "passed" : "limited";
    });
    expect(pushes.length).toBeGreaterThanOrEqual(10);
  });
});

describe("端末の登録の攻撃と制限", () => {
  it("同じインストールで登録を並べて送っても、ほかの人のトークンを確かめたことにはできない", async () => {
    const { app, pushes } = appWithPushes();
    const victim = await enrollNewDevice();
    const victimToken = newApnsToken();
    await putDevice(app, victim, { apnsToken: victimToken });
    await confirm(app, victim.enrolled, pushes[0]?.code ?? "");
    const victimDevices = await activeDeviceIds(victim.enrolled);
    // 入り交じり方は時間で決まるので、このテストは入り交じったときの振る舞いの確かめにとどまる。記録を送る先のトークンで置くことは、
    // DB のテスト (test/db/devices.test.ts の「記録は、送る先のトークンが今の端末のトークンで…」) が、時間によらず確かめる。

    // 回ごとに攻撃する人を作り直す (インストールごとの登録の制限に、回をまたいで届かないように)。
    for (let round = 0; round < 3; round++) {
      const attacker = await enrollNewDevice();
      const attackerToken = newApnsToken();
      // 署名した 2 つの要求を先に作り、同じ tick で送る (端末の行の書き換えと、確かめの記録を置くのが入り交じるように)。
      const signedPut = async (input: DeviceInput) => {
        const challenge = await issueTestChallenge("device");
        const signature = await attacker.device.sign(
          deviceMessage(challenge, attacker.enrolled.installation_id, {
            apnsEnvironment: "sandbox",
            topic: TOPIC,
            apnsToken: input.apnsToken,
            enabled: input.enabled,
          }),
        );
        return () => putDevice(app, attacker, input, { challenge, signature });
      };
      const requests = [
        await signedPut({ apnsToken: attackerToken, enabled: false }),
        await signedPut({ apnsToken: victimToken }),
      ];
      const sent = pushes.length;
      const responses = await Promise.all(requests.map((send) => send()));
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      // 攻撃する側が受け取れるのは、自分の端末 (attackerToken) へ届いた code だけ。届いたらすぐに返す。
      for (const push of pushes.slice(sent).filter((push) => push.apnsToken === attackerToken)) {
        await confirm(app, attacker.enrolled, push.code);
      }
      expect(await activeDeviceIds(victim.enrolled), `round ${round}`).toEqual(victimDevices);
    }
  });

  it("環境を入れ替えると、確かめ直すまで送らず、その環境へ push を送る", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();
    await putDevice(app, owner, { apnsToken });
    await confirm(app, owner.enrolled, pushes[0]?.code ?? "");

    const switched = await (
      await putDevice(app, owner, { apnsToken, apnsEnvironment: "production" })
    ).json<DeviceResult>();

    expect(switched).toMatchObject({ verified: false, verification_sent: true });
    expect(pushes[1]?.apnsEnvironment).toBe("production");
    expect(await activeDeviceIds(owner.enrolled)).toEqual([]);
  });

  it("確かめの記録には、code の平文を置かない", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    await putDevice(app, owner, { apnsToken: newApnsToken() });
    const code = pushes[0]?.code ?? "";

    const rows = await env.DB.prepare("SELECT * FROM device_verifications").all();

    expect(JSON.stringify(rows.results)).not.toContain(code.slice(4));
  });

  it("確かめていない持ち主の code は、ほかの人が同じトークンを登録しても使える", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    const other = await enrollNewDevice();
    const apnsToken = newApnsToken();
    await putDevice(app, owner, { apnsToken });
    const ownerCode = pushes[0]?.code ?? "";

    await putDevice(app, other, { apnsToken });

    expect((await confirm(app, owner.enrolled, ownerCode)).status).toBe(200);
  });

  it("登録は、署名を確かめた後に、インストールごとに数える", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();
    for (let attempt = 0; attempt < 5; attempt++) {
      await expectProblem(
        await putDevice(app, owner, { apnsToken }, { signer: await newDeviceKey() }),
        401,
      );
    }
    await expectLimitReached(5, async () =>
      outcomeOf((await putDevice(app, owner, { apnsToken })).status, 200),
    );
  });

  it("確かめはセッションごとに数え、ほかのセッションで違う code を送り続けられても、持ち主は確かめられる", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    await putDevice(app, owner, { apnsToken: newApnsToken() });
    const leaked = owner.enrolled;
    await expectLimitReached(5, async () =>
      outcomeOf((await confirm(app, leaked, `tsv_${"A".repeat(43)}`)).status, 422),
    );

    const challenge = await issueTestChallenge("session");
    const sessionResponse = await call("POST", "/v1/sessions", {
      body: {
        installation_id: owner.enrolled.installation_id,
        challenge,
        signature: await owner.device.sign(
          sessionMessage(challenge, owner.enrolled.installation_id),
        ),
      },
    });
    const { session } = await sessionResponse.json<{ session: { token: string } }>();

    expect(
      (
        await confirm(
          app,
          { ...owner.enrolled, session: { ...owner.enrolled.session, token: session.token } },
          pushes[0]?.code ?? "",
        )
      ).status,
    ).toBe(200);
  });

  it("enabled は署名の対象で、署名と違う enabled では登録できない", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();
    const challenge = await issueTestChallenge("device");
    const signature = await owner.device.sign(
      deviceMessage(challenge, owner.enrolled.installation_id, {
        apnsEnvironment: "sandbox",
        topic: TOPIC,
        apnsToken,
        enabled: true,
      }),
    );

    await expectProblem(
      await putDevice(app, owner, { apnsToken, enabled: false }, { challenge, signature }),
      401,
    );
  });
});

describe("端末の確かめの push の枠", () => {
  it("トークンへの push の枠が埋まっていても、持ち主の登録し直しで、届いている code を消さない", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();
    await putDevice(app, owner, { apnsToken });
    const delivered = pushes[0]?.code ?? "";
    await expectLimitReached(9, async () => {
      const response = await putDevice(app, await enrollNewDevice(), { apnsToken });
      return (await response.json<DeviceResult>()).verification_sent ? "passed" : "limited";
    });

    const again = await (await putDevice(app, owner, { apnsToken })).json<DeviceResult>();

    // 区切りをまたいで枠が空いたときは、新しい code を送り、それで確かめる。
    const code = again.verification_sent ? (pushes.at(-1)?.code ?? "") : delivered;
    expect((await confirm(app, owner.enrolled, code)).status).toBe(200);
  });
});

describe("端末の通知を止める", () => {
  it("止めると送り先から外れ、トークンを登録し直しても止めたまま。enabled: true で戻す", async () => {
    const { app, pushes } = appWithPushes();
    const owner = await enrollNewDevice();
    const apnsToken = newApnsToken();
    await putDevice(app, owner, { apnsToken });
    await confirm(app, owner.enrolled, pushes[0]?.code ?? "");
    const path = `/v1/devices/${owner.enrolled.installation_id}`;

    expect((await request(app, "DELETE", path, owner.enrolled.session.token)).status).toBe(204);
    expect(await activeDeviceIds(owner.enrolled)).toEqual([]);

    expect(await (await putDevice(app, owner, { apnsToken })).json()).toMatchObject({
      state: "disabled_by_user",
    });
    expect(await (await putDevice(app, owner, { apnsToken, enabled: true })).json()).toMatchObject({
      state: "active",
      verified: true,
    });
    expect(await activeDeviceIds(owner.enrolled)).toHaveLength(1);
  });

  it("止めるのは、インストールごとに数える", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    await putDevice(app, owner, { apnsToken: newApnsToken() });
    const path = `/v1/devices/${owner.enrolled.installation_id}`;

    await expectLimitReached(5, async () =>
      outcomeOf((await request(app, "DELETE", path, owner.enrolled.session.token)).status, 204),
    );
  });

  it("端末がない、セッションがないときは、止められない", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    const path = `/v1/devices/${owner.enrolled.installation_id}`;

    await expectProblem(await request(app, "DELETE", path, owner.enrolled.session.token), 404);
    await expectProblem(await request(app, "DELETE", path, undefined), 401);
  });
});
