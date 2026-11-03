import { env } from "cloudflare:workers";
import {
  beginEvent,
  createDb,
  listActiveDevices,
  registerDeviceToken,
  revokeRelayCredential,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { OutgoingNotification } from "../src/notifications/payload";
import type { PushOutcome, PushTarget } from "../src/notifications/push";
import { MAX_EVENT_AGE_MS } from "../src/routes/notifications";
import { loadDeviceTokenKeys, sealDeviceToken } from "../src/security/device-token";
import { consumedChallenge, TOPIC, verifyDevice } from "./db/helpers";
import { type Enrolled, enrollNewDevice, expectProblem } from "./helpers/api";
import { jsonHeaders } from "./helpers/http";
import { expectLimitReached, outcomeOf } from "./helpers/rate-limit";

type Sent = { target: PushTarget; notification: OutgoingNotification };

/** 通知を、送らずに記録する app。`outcome` で、送り手の結果を決める。 */
function appWithPush(outcome: () => Promise<PushOutcome> = async () => "sent") {
  const sent: Sent[] = [];
  const app = createApp({
    push: async (target, notification) => {
      sent.push({ target, notification });
      return outcome();
    },
  });
  return { app, sent };
}

function newApnsToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** 登録して、トークンを持っていることを確かめた端末を持つアカウント。 */
async function accountWithDevice() {
  const { enrolled } = await enrollNewDevice();
  const apnsToken = newApnsToken();
  const sealed = await sealDeviceToken(await loadDeviceTokenKeys(env), apnsToken, {
    installationId: enrolled.installation_id,
    apnsEnvironment: "sandbox",
    topic: TOPIC,
  });
  const db = createDb(env.DB);
  const owner = { accountId: enrolled.account_id, installationId: enrolled.installation_id };
  const registered = await registerDeviceToken(db, {
    ...owner,
    apnsTokenCiphertext: sealed.ciphertext,
    tokenFingerprint: sealed.fingerprint,
    apnsEnvironment: "sandbox",
    topic: TOPIC,
    challenge: consumedChallenge(),
  });
  if (registered.kind !== "registered") throw new Error("device was not registered");
  expect(await verifyDevice(db, owner, registered.deviceId)).toBe(true);
  return { enrolled, apnsToken, deviceId: registered.deviceId };
}

function newEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: `event-${crypto.randomUUID()}`,
    type: "mention",
    post_id: "1234567890123456789",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

async function relay(app: ReturnType<typeof createApp>, secret: string | undefined, body: unknown) {
  const headers = jsonHeaders();
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  return app.request(
    "https://notification.test/v1/notifications",
    { method: "POST", headers, body: JSON.stringify(body) },
    env,
  );
}

describe("中継の受け付け", () => {
  it("中継の資格情報のアカウントの端末へ、中身を運ばない一般的な通知を送り、202 を返す", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const event = newEvent();

    const response = await relay(app, alice.enrolled.relay_secret, event);

    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ event_id: event.event_id, status: "accepted" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toMatchObject({
      deviceId: alice.deviceId,
      apnsToken: alice.apnsToken,
      apnsEnvironment: "sandbox",
      topic: TOPIC,
    });
    expect(sent[0]?.notification).toEqual({
      eventId: event.event_id,
      payload: {
        aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
        event_type: "mention",
        post_id: "1234567890123456789",
      },
    });
  });

  it("ほかのアカウントの端末へは送らない", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const bob = await accountWithDevice();

    await relay(app, alice.enrolled.relay_secret, newEvent());

    expect(sent.map((item) => item.target.deviceId)).toEqual([alice.deviceId]);
    expect(sent.map((item) => item.target.deviceId)).not.toContain(bob.deviceId);
  });

  it("同じ event_id は 1 回だけ送り、やり直しには duplicate を返す。アカウントが違えば別のイベント", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const bob = await accountWithDevice();
    const event = newEvent();

    await relay(app, alice.enrolled.relay_secret, event);
    const again = await relay(app, alice.enrolled.relay_secret, event);
    await relay(app, bob.enrolled.relay_secret, event);

    expect(await again.json()).toEqual({ event_id: event.event_id, status: "duplicate" });
    expect(sent.map((item) => item.target.deviceId)).toEqual([alice.deviceId, bob.deviceId]);
  });

  it("同じイベントを送っている途中のやり直しは、409 と Retry-After", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const event = newEvent();
    await beginEvent(createDb(env.DB), {
      accountId: alice.enrolled.account_id,
      eventId: event.event_id,
    });

    const response = await relay(app, alice.enrolled.relay_secret, event);

    expect(response.headers.get("Retry-After")).toBe("30");
    await expectProblem(response, 409);
    expect(sent).toEqual([]);
  });

  it("送る途中で失敗したら 503 と Retry-After を返し、やり直しを受け付ける", async () => {
    const alice = await accountWithDevice();
    const event = newEvent();
    const failing = appWithPush(async () => {
      throw new Error("token=secret-value");
    });

    const failed = await relay(failing.app, alice.enrolled.relay_secret, event);

    expect(failed.headers.get("Retry-After")).toBe("60");
    const problem = await expectProblem(failed, 503);
    expect(JSON.stringify(problem)).not.toContain("secret-value");
    const working = appWithPush();
    const retried = await relay(working.app, alice.enrolled.relay_secret, event);
    expect(await retried.json()).toEqual({ event_id: event.event_id, status: "accepted" });
    expect(working.sent).toHaveLength(1);
  });

  it("APNs がトークンを無効と返したら、端末を止める", async () => {
    const { app } = appWithPush(async () => "invalid_token");
    const alice = await accountWithDevice();

    expect((await relay(app, alice.enrolled.relay_secret, newEvent())).status).toBe(202);

    expect(await listActiveDevices(createDb(env.DB), alice.enrolled.account_id)).toEqual([]);
  });

  it("確かめた端末がなければ、送らずに受け付ける。APNs へ送る仕組みがなくても受け付ける", async () => {
    const { app, sent } = appWithPush();
    const { enrolled } = await enrollNewDevice();
    const alice = await accountWithDevice();

    expect((await relay(app, enrolled.relay_secret, newEvent())).status).toBe(202);
    expect(sent).toEqual([]);
    expect((await relay(createApp(), alice.enrolled.relay_secret, newEvent())).status).toBe(202);
  });

  it("本文で、送り先、X の ID、トークン、文、URL を受けない。種類、ID、時刻の形も確かめる", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();

    for (const extra of [
      { account_id: crypto.randomUUID() },
      { x_user_id: "12345" },
      { apns_token: newApnsToken() },
      { title: "Hello" },
      { body: "Hello" },
      { url: "https://example.com" },
      { type: "dm" },
      { post_id: "abc" },
      { post_id: "0123" },
      { event_id: "has space" },
      { event_id: "" },
      { occurred_at: "2026-11-04T09:00:00+09:00" },
      { occurred_at: "yesterday" },
    ]) {
      await expectProblem(await relay(app, alice.enrolled.relay_secret, newEvent(extra)), 422);
    }
    expect(sent).toEqual([]);
  });

  it("古すぎるイベント (受け付けの記録が消えた後のやり直し) と、先の時刻のイベントは 422", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const now = Date.now();

    for (const occurredAt of [now - MAX_EVENT_AGE_MS - 60_000, now + 10 * 60 * 1000]) {
      const problem = await expectProblem(
        await relay(
          app,
          alice.enrolled.relay_secret,
          newEvent({ occurred_at: new Date(occurredAt).toISOString() }),
        ),
        422,
      );
      expect(problem.detail).toBe("The event time is out of range.");
    }
    expect(
      (
        await relay(
          app,
          alice.enrolled.relay_secret,
          newEvent({ occurred_at: new Date(now - MAX_EVENT_AGE_MS + 60_000).toISOString() }),
        )
      ).status,
    ).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it("中継の資格情報がない、セッションのトークン、取り消した資格情報は 401 で、秘密を返さない", async () => {
    const { app, sent } = appWithPush();
    const alice = await accountWithDevice();
    const revoked: Enrolled = (await enrollNewDevice()).enrolled;
    await revokeRelayCredential(createDb(env.DB), {
      accountId: revoked.account_id,
      credentialId: revoked.relay_credential_id ?? "",
    });

    for (const secret of [undefined, alice.enrolled.session.token, revoked.relay_secret]) {
      const response = await relay(app, secret, newEvent());
      const text = await response.clone().text();
      await expectProblem(response, 401);
      if (secret !== undefined) expect(text).not.toContain(secret);
    }
    expect(sent).toEqual([]);
  });

  it("アカウントごとに数え、多すぎると 429", async () => {
    const { app } = appWithPush();
    const alice = await accountWithDevice();

    await expectLimitReached(60, async () =>
      outcomeOf((await relay(app, alice.enrolled.relay_secret, newEvent())).status, 202),
    );
  });
});
