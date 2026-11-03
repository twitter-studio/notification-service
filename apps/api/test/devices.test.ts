import { env } from "cloudflare:workers";
import { createDb, listActiveDevices } from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { DeviceVerificationPush } from "../src/devices/verification";
import { deviceMessage } from "../src/security/installation-key";
import {
  type DeviceKey,
  type Enrolled,
  enrollNewDevice,
  expectProblem,
  issueTestChallenge,
} from "./helpers/api";
import { newDeviceKey } from "./helpers/device-key";
import { jsonHeaders } from "./helpers/http";

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

  it("同じトークンの登録が多すぎると、アカウントが違っても 429", async () => {
    const { app } = appWithPushes();
    const apnsToken = newApnsToken();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push((await putDevice(app, await enrollNewDevice(), { apnsToken })).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
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

  it("端末がない、セッションがないときは、止められない", async () => {
    const { app } = appWithPushes();
    const owner = await enrollNewDevice();
    const path = `/v1/devices/${owner.enrolled.installation_id}`;

    await expectProblem(await request(app, "DELETE", path, owner.enrolled.session.token), 404);
    await expectProblem(await request(app, "DELETE", path, undefined), 401);
  });
});
