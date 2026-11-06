import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import worker from "../src/index";
import { hashBearerToken } from "../src/security/bearer";
import { challengeKeyFromEnv, issueChallenge } from "../src/security/challenge";
import { toBase64Url } from "../src/security/encoding";
import {
  deleteAccountMessage,
  deviceMessage,
  enrollmentMessage,
  sessionMessage,
} from "../src/security/installation-key";
import type { Enrolled } from "./helpers/api";
import { newDeviceKey } from "./helpers/device-key";
import { jsonHeaders } from "./helpers/http";
import { fixture, policy } from "./security/app-attest/fixtures";

const production = {
  ...env,
  APP_ATTEST_POLICY: JSON.stringify({ ...policy, mode: "required", environment: "production" }),
};

async function trialEnrollment() {
  const device = await newDeviceKey();
  const challenge = (await issueChallenge(await challengeKeyFromEnv(env), "enroll")).challenge;
  const message = enrollmentMessage(challenge, device.publicKey);
  const attest = await fixture({
    environment: "production",
    clientData: new TextEncoder().encode(message),
  });
  const body = {
    challenge,
    public_key: device.publicKey,
    signature: await device.sign(message),
    app_attest: {
      kind: "attestation",
      key_id: toBase64Url(attest.input.keyId),
      data: toBase64Url(attest.input.object),
    },
  };
  return { body, attest, device };
}

it("公開実機試験は招待とApp Attestを要求し、期限後は登録と配送を閉じる", async () => {
  const { body, attest, device } = await trialEnrollment();
  const sendDeviceVerification = vi.fn(async () => true);
  const app = createApp({ appAttestVerifier: attest.verifier, sendDeviceVerification });
  const invite = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA";
  const inviteHash = await hashBearerToken(invite);
  const until = Date.now() + 60_000;
  const trial = {
    ...production,
    PUBLIC_TRIAL: JSON.stringify({ until, inviteHash }),
  };
  const expired = { ...trial, PUBLIC_TRIAL: JSON.stringify({ until: Date.now() - 1, inviteHash }) };
  const enroll = (config: typeof trial, input: unknown, target = app) =>
    target.request(
      "https://notification.test/v1/enrollments",
      { method: "POST", headers: jsonHeaders(), body: JSON.stringify(input) },
      config,
    );
  expect((await enroll(trial, body)).status).toBe(403);
  expect(
    (await enroll(trial, { ...body, invite_code: invite, app_attest: undefined })).status,
  ).toBe(401);
  expect((await enroll(expired, { ...body, invite_code: invite })).status).toBe(403);
  const clock = vi.spyOn(Date, "now");
  try {
    const crossing = createApp({
      appAttestVerifier: {
        ...attest.verifier,
        async attestation(input) {
          const proof = await attest.verifier.attestation(input);
          clock.mockReturnValue(until);
          return proof;
        },
      },
    });
    expect((await enroll(trial, { ...body, invite_code: invite }, crossing)).status).toBe(403);
  } finally {
    clock.mockRestore();
  }
  const registered = await enroll(trial, { ...body, invite_code: invite });
  expect(registered.status).toBe(201);
  const second = await trialEnrollment();
  expect(
    (
      await enroll(
        trial,
        { ...second.body, invite_code: invite },
        createApp({ appAttestVerifier: second.attest.verifier }),
      )
    ).status,
  ).toBe(409);
  const owner = await registered.json<Enrolled>();
  const resume = { ...production, PUBLIC_TRIAL: JSON.stringify({ until, resume: true }) };
  expect((await enroll(resume, { ...body, invite_code: invite })).status).toBe(403);
  const registerDevice = async (config: typeof trial, apnsToken: string) => {
    const key = await challengeKeyFromEnv(env);
    const { challenge } = await issueChallenge(key, "device");
    const registration = {
      apnsEnvironment: "production" as const,
      topic: "com.twitter-studio.Tweetbot",
      apnsToken,
      enabled: undefined,
    };
    return app.request(
      `https://notification.test/v1/devices/${owner.installation_id}`,
      {
        method: "PUT",
        headers: { ...jsonHeaders(), Authorization: `Bearer ${owner.session.token}` },
        body: JSON.stringify({
          challenge,
          signature: await device.sign(
            deviceMessage(challenge, owner.installation_id, registration),
          ),
          apns_token: apnsToken,
          apns_environment: registration.apnsEnvironment,
          topic: registration.topic,
        }),
      },
      config,
    );
  };
  const apnsToken = "a".repeat(64);
  expect((await registerDevice(trial, apnsToken)).status).toBe(200);
  expect((await registerDevice(resume, "b".repeat(64))).status).toBe(401);
  expect(sendDeviceVerification).toHaveBeenCalledTimes(1);
  expect((await registerDevice(resume, apnsToken)).status).toBe(200);
  expect(sendDeviceVerification).toHaveBeenCalledTimes(2);
  const relay = await app.request(
    "https://notification.test/v1/notifications",
    {
      method: "POST",
      headers: { ...jsonHeaders(), Authorization: `Bearer ${owner.relay_secret}` },
      body: JSON.stringify({
        event_id: "resume-relay",
        type: "follow",
        occurred_at: new Date().toISOString(),
      }),
    },
    resume,
  );
  expect(relay.status).toBe(503);
  const resumedTest = await app.request(
    "https://notification.test/v1/notifications/test",
    { method: "POST", headers: { Authorization: `Bearer ${owner.session.token}` } },
    resume,
  );
  // 配送停止の503ではなく、所有確認を終えていない端末に対する409を返す。
  expect(resumedTest.status).toBe(409);
  const test = await app.request(
    "https://notification.test/v1/notifications/test",
    { method: "POST", headers: { Authorization: `Bearer ${owner.session.token}` } },
    expired,
  );
  expect(test.status).toBe(503);
});

it("公開登録とAPNs送信を個別に停止しても、既存のセッション更新、設定、削除を続けられる", async () => {
  const device = await newDeviceKey();
  const key = await challengeKeyFromEnv(env);
  const enrollment = (await issueChallenge(key, "enroll")).challenge;
  const message = enrollmentMessage(enrollment, device.publicKey);
  const attest = await fixture({
    environment: "production",
    clientData: new TextEncoder().encode(message),
  });
  const push = vi.fn(async () => ({ kind: "sent" as const }));
  const sendDeviceVerification = vi.fn(async () => true);
  const app = createApp({ appAttestVerifier: attest.verifier, push, sendDeviceVerification });
  const request = (
    config: typeof production,
    path: string,
    method: string,
    body?: unknown,
    token?: string,
  ) =>
    app.request(
      `https://notification.test${path}`,
      {
        method,
        headers: {
          ...jsonHeaders(),
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      config,
    );
  const body = {
    challenge: enrollment,
    public_key: device.publicKey,
    signature: await device.sign(message),
    app_attest: {
      kind: "attestation",
      key_id: toBase64Url(attest.input.keyId),
      data: toBase64Url(attest.input.object),
    },
  };
  const sendOnly = { ...production, PUBLIC_DELIVERY_ENABLED: "true" };
  expect((await request(sendOnly, "/v1/enrollments", "POST", body)).status).toBe(403);
  const enrollOnly = { ...production, PUBLIC_ENROLLMENT_ENABLED: "true" };
  expect(
    (await request(enrollOnly, "/v1/enrollments", "POST", { ...body, app_attest: undefined }))
      .status,
  ).toBe(401);
  const registered = await request(enrollOnly, "/v1/enrollments", "POST", body);
  expect(registered.status).toBe(201);
  const owner = await registered.json<Enrolled>();
  const paused = { ...production, PUBLIC_DELIVERY_ENABLED: "invalid" };

  const check = (await issueChallenge(key, "session")).challenge;
  const sessionProof = sessionMessage(check, owner.installation_id);
  const renewed = await request(paused, "/v1/sessions", "POST", {
    installation_id: owner.installation_id,
    challenge: check,
    signature: await device.sign(sessionProof),
    app_attest: {
      kind: "assertion",
      key_id: body.app_attest.key_id,
      data: toBase64Url(await attest.assertion(1, new TextEncoder().encode(sessionProof))),
    },
  });
  expect(renewed.status).toBe(201);
  const { session } = await renewed.json<{ session: { token: string } }>();
  expect((await request(paused, "/v1/settings", "GET", undefined, session.token)).status).toBe(200);
  const test = await request(paused, "/v1/notifications/test", "POST", undefined, session.token);
  expect(test.status).toBe(503);
  expect(test.headers.get("Retry-After")).toBe("900");
  expect(
    (
      await request(
        paused,
        `/v1/devices/${owner.installation_id}`,
        "PUT",
        {
          apns_token: "a".repeat(64),
          apns_environment: "production",
          topic: "com.twitter-studio.Tweetbot",
          challenge: "",
          signature: "",
        },
        session.token,
      )
    ).status,
  ).toBe(503);
  expect(owner.relay_secret).toBeDefined();
  expect(
    (
      await request(
        paused,
        "/v1/notifications",
        "POST",
        {
          event_id: "test-event",
          type: "follow",
          occurred_at: new Date().toISOString(),
        },
        owner.relay_secret,
      )
    ).status,
  ).toBe(503);
  expect(push).not.toHaveBeenCalled();
  expect(sendDeviceVerification).not.toHaveBeenCalled();

  const deletion = (await issueChallenge(key, "delete_account")).challenge;
  expect(
    (
      await request(
        paused,
        "/v1/account",
        "DELETE",
        {
          challenge: deletion,
          signature: await device.sign(deleteAccountMessage(deletion, owner.installation_id)),
        },
        session.token,
      )
    ).status,
  ).toBe(204);
});

it("公開配送の停止中に受け取った再送はAPNsへ送らず破棄する", async () => {
  const id = crypto.randomUUID();
  const batch = createMessageBatch("notification-apns-retries", [
    { id, timestamp: new Date(), attempts: 1, body: {} },
  ]);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await worker.queue(batch, production);
    expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toEqual([id]);
    expect(info).toHaveBeenCalledWith({ event: "delivery_discarded", reason: "operations_paused" });
  } finally {
    info.mockRestore();
  }
});

it("公開再試験中はQueueの中継再送を破棄する", async () => {
  const config = {
    ...production,
    PUBLIC_TRIAL: JSON.stringify({ until: Date.now() + 60_000, resume: true }),
  };
  const id = crypto.randomUUID();
  const batch = createMessageBatch("notification-apns-retries", [
    {
      id,
      timestamp: new Date(),
      attempts: 1,
      body: {
        accountId: crypto.randomUUID(),
        authority: { kind: "relay", credentialId: crypto.randomUUID() },
        deviceId: crypto.randomUUID(),
        fingerprint: `f1.${"a".repeat(43)}`,
        environment: "production",
        topic: "com.twitter-studio.Tweetbot",
        eventKey: "b".repeat(43),
        apnsId: crypto.randomUUID(),
        expiresAt: Date.now() + 60_000,
        payload: {
          aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
          event_type: "follow",
        },
      },
    },
  ]);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await worker.queue(batch, config);
    expect((await getQueueResult(batch, createExecutionContext())).explicitAcks).toEqual([id]);
    expect(info).toHaveBeenCalledWith({ event: "delivery_discarded", reason: "operations_paused" });
  } finally {
    info.mockRestore();
  }
});
