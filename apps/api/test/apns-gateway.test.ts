import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createDb,
  disableDeviceByUser,
  listActiveDevices,
  registerDeviceToken,
  revokeInstallation,
  revokeRelayCredential,
} from "@notification-service/db";
import { describe, expect, it, vi } from "vitest";
import { ApnsPushGateway, retryDelay } from "../src/apns/gateway";
import { notificationPayload } from "../src/notifications/payload";
import type { PushTarget } from "../src/notifications/push";
import { loadDeviceTokenKeys, sealDeviceToken } from "../src/security/device-token";
import { consumedChallenge, newAccount, TOPIC, verifyDevice } from "./db/helpers";
import { signingConfiguration } from "./helpers/apns";

async function accountWithDevice() {
  const db = createDb(env.DB);
  const owner = await newAccount(db);
  if (!owner.created) throw new Error("new account expected");
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const sealed = await sealDeviceToken(await loadDeviceTokenKeys(env), token, {
    installationId: owner.installationId,
    apnsEnvironment: "sandbox",
    topic: TOPIC,
  });
  const registered = await registerDeviceToken(db, {
    ...owner,
    apnsTokenCiphertext: sealed.ciphertext,
    tokenFingerprint: sealed.fingerprint,
    apnsEnvironment: "sandbox",
    topic: TOPIC,
    challenge: consumedChallenge(),
  });
  if (registered.kind !== "registered") throw new Error("registration failed");
  expect(await verifyDevice(db, owner, registered.deviceId)).toBe(true);
  return {
    owner,
    target: {
      accountId: owner.accountId,
      authority: { kind: "relay", credentialId: owner.relayCredentialId },
      registrationCiphertext: sealed.ciphertext,
      deviceId: registered.deviceId,
      tokenFingerprint: sealed.fingerprint,
      apnsToken: token,
      apnsEnvironment: "sandbox" as const,
      topic: TOPIC,
    } satisfies PushTarget,
  };
}

function notification() {
  return {
    eventKey: "a".repeat(43),
    payload: notificationPayload({ eventId: "test", type: "follow" }),
  };
}

async function setup(status = 503) {
  const config = await signingConfiguration();
  const jobs: unknown[] = [];
  const delays: (number | undefined)[] = [];
  const requests: RequestInit[] = [];
  let responseStatus = status;
  let now = Date.now();
  const send = vi.fn<typeof fetch>(async (_url, init) => {
    if (init) requests.push(init);
    return responseStatus === 200
      ? new Response()
      : new Response(
          JSON.stringify({
            reason: responseStatus === 410 ? "Unregistered" : "anything",
            timestamp: Date.now(),
          }),
          { status: responseStatus },
        );
  });
  const gateway = new ApnsPushGateway(
    { ...env, APNS_PROVIDER_KEYS: config.json },
    {
      send,
      now: () => now,
      queue: {
        async send(body, options) {
          jobs.push(body);
          delays.push(options?.delaySeconds);
          return { metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } };
        },
      },
    },
  );
  return {
    gateway,
    jobs,
    delays,
    send,
    requests,
    setStatus: (s: number) => {
      responseStatus = s;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function consume(gateway: ApnsPushGateway, body: unknown, attempts = 1) {
  const id = crypto.randomUUID();
  const batch = createMessageBatch("notification-apns-retries", [
    { id, timestamp: new Date(), attempts, body },
  ]);
  const retry = batch.messages[0] === undefined ? undefined : vi.spyOn(batch.messages[0], "retry");
  const ctx = createExecutionContext();
  await gateway.consume(batch);
  return { id, retry, result: await getQueueResult(batch, ctx) };
}

describe("APNs の遅延再送", () => {
  it.each([429, 503])(
    "%s の自動 Queue 投入・再送・打ち切りを識別子なしで集計できる",
    async (status) => {
      const account = await accountWithDevice();
      const test = await setup(status);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(
          await test.gateway.push(account.target, notification(), {
            signal: new AbortController().signal,
          }),
        ).toEqual({ kind: "queued" });
        await consume(test.gateway, test.jobs[0], 1);
        const last = await consume(test.gateway, test.jobs[0], 2);
        expect(last.result.explicitAcks).toEqual([last.id]);
        expect(test.send).toHaveBeenCalledTimes(3);
        expect(info.mock.calls).toContainEqual([
          expect.objectContaining({ event: "delivery_retry", stage: "queued", attempt: 1 }),
        ]);
        expect(info.mock.calls).toContainEqual([
          expect.objectContaining({ event: "delivery_retry", stage: "requeued", attempt: 2 }),
        ]);
        expect(info.mock.calls.filter(([entry]) => entry.event === "apns_response")).toHaveLength(
          3,
        );
        expect(JSON.stringify(error.mock.calls)).toContain("apns_delivery_exhausted");
        const logs = JSON.stringify([...info.mock.calls, ...error.mock.calls]);
        for (const secret of [
          account.target.apnsToken,
          account.target.registrationCiphertext,
          account.target.tokenFingerprint,
          account.target.accountId,
          account.target.deviceId,
        ])
          expect(logs).not.toContain(secret);
      } finally {
        info.mockRestore();
        error.mockRestore();
      }
    },
  );
  it("テスト通知の再送は中継資格情報の取り消しに依存せず、インストールの取り消しには従う", async () => {
    const account = await accountWithDevice();
    const test = await setup();
    const target: PushTarget = {
      ...account.target,
      authority: { kind: "installation", installationId: account.owner.installationId },
    };
    await test.gateway.push(target, notification(), { signal: new AbortController().signal });
    await revokeRelayCredential(createDb(env.DB), {
      accountId: account.owner.accountId,
      credentialId: account.owner.relayCredentialId,
    });
    test.setStatus(200);
    await consume(test.gateway, test.jobs[0]);
    expect(test.send).toHaveBeenCalledTimes(2);
    await revokeInstallation(createDb(env.DB), account.owner);
    await consume(test.gateway, test.jobs[0]);
    expect(test.send).toHaveBeenCalledTimes(2);
  });
  it("別のアカウントのインストールを根拠とする再送を拒む", async () => {
    const account = await accountWithDevice();
    const other = await accountWithDevice();
    const test = await setup();
    const target: PushTarget = {
      ...account.target,
      authority: { kind: "installation", installationId: other.owner.installationId },
    };
    await test.gateway.push(target, notification(), { signal: new AbortController().signal });
    test.setStatus(200);
    const { id, result } = await consume(test.gateway, test.jobs[0]);
    expect(result.explicitAcks).toEqual([id]);
    expect(test.send).toHaveBeenCalledTimes(1);
  });

  it("一時障害だけ Queue に渡し、平文トークンや署名鍵を残さず、同じ ID で再送する", async () => {
    const account = await accountWithDevice();
    const test = await setup();
    expect(
      await test.gateway.push(account.target, notification(), {
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "queued" });
    expect(test.jobs).toHaveLength(1);
    expect(test.delays[0]).toBeGreaterThanOrEqual(900);
    expect(test.delays[0]).toBeLessThan(990);
    expect(JSON.stringify(test.jobs)).not.toContain(account.target.apnsToken);
    expect(JSON.stringify(test.jobs)).not.toContain("PRIVATE KEY");
    test.setStatus(200);
    test.advance(900_000);
    const { id, result } = await consume(test.gateway, test.jobs[0]);
    expect(result.explicitAcks).toEqual([id]);
    expect(test.send).toHaveBeenCalledTimes(2);
    expect(new Headers(test.requests[0]?.headers).get("apns-id")).toBe(
      new Headers(test.requests[1]?.headers).get("apns-id"),
    );
    expect(new Headers(test.requests[1]?.headers).get("apns-collapse-id")).toBe(
      notification().eventKey,
    );
  });

  it("5xx の2回目も15分以上待ち、初回を含む3回の送信で打ち切る", async () => {
    const account = await accountWithDevice();
    const test = await setup();
    await test.gateway.push(account.target, notification(), {
      signal: new AbortController().signal,
    });
    const first = await consume(test.gateway, test.jobs[0], 1);
    expect(first.result.retryMessages).toEqual([{ msgId: first.id }]);
    expect(first.retry?.mock.calls[0]?.[0]?.delaySeconds).toBeGreaterThanOrEqual(1800);
    const last = await consume(test.gateway, test.jobs[0], 2);
    expect(last.result.retryMessages).toEqual([]);
    expect(last.result.explicitAcks).toEqual([last.id]);
    expect(test.send).toHaveBeenCalledTimes(3);
  });

  it.each([
    "disabled",
    "revoked",
    "credential_revoked",
    "rotated",
    "wrong_account",
    "expired",
    "invalid_job",
  ] as const)("%s の仕事は再送しない", async (change) => {
    const account = await accountWithDevice();
    const test = await setup();
    await test.gateway.push(account.target, notification(), {
      signal: new AbortController().signal,
    });
    const db = createDb(env.DB);
    let job = test.jobs[0];
    if (change === "disabled")
      await disableDeviceByUser(db, {
        accountId: account.owner.accountId,
        deviceId: account.target.deviceId,
      });
    if (change === "credential_revoked")
      await revokeRelayCredential(db, {
        accountId: account.owner.accountId,
        credentialId: account.owner.relayCredentialId,
      });
    if (change === "revoked") await revokeInstallation(db, account.owner);
    if (change === "rotated") {
      const sealed = await sealDeviceToken(await loadDeviceTokenKeys(env), "01".repeat(32), {
        installationId: account.owner.installationId,
        apnsEnvironment: "sandbox",
        topic: TOPIC,
      });
      await registerDeviceToken(db, {
        ...account.owner,
        apnsTokenCiphertext: sealed.ciphertext,
        tokenFingerprint: sealed.fingerprint,
        apnsEnvironment: "sandbox",
        topic: TOPIC,
        challenge: consumedChallenge(),
      });
      await verifyDevice(db, account.owner, account.target.deviceId);
    }
    if (change === "wrong_account")
      job = { ...JSON.parse(JSON.stringify(job)), accountId: crypto.randomUUID() };
    if (change === "expired") test.advance(3600_001);
    if (change === "invalid_job") job = { token: "do-not-send" };
    const { id, result } = await consume(test.gateway, job);
    expect(result.explicitAcks).toEqual([id]);
    expect(test.send).toHaveBeenCalledTimes(1);
  });

  it("再送で410になった端末を指紋と照合して止める", async () => {
    const account = await accountWithDevice();
    const test = await setup();
    await test.gateway.push(account.target, notification(), {
      signal: new AbortController().signal,
    });
    test.setStatus(410);
    await consume(test.gateway, test.jobs[0]);
    expect(await listActiveDevices(createDb(env.DB), account.owner.accountId)).toEqual([]);
  });

  it.each([200, 403, 410])("%i は Queue に置かない", async (status) => {
    const account = await accountWithDevice();
    const test = await setup(status);
    await test.gateway.push(account.target, notification(), {
      signal: new AbortController().signal,
    });
    expect(test.jobs).toEqual([]);
  });

  it("所有確認 code は background push だけに入れ、Queue に残さない", async () => {
    const account = await accountWithDevice();
    const test = await setup(200);
    expect(
      await test.gateway.sendDeviceVerification({
        ...account.target,
        code: "test-verification-code",
      }),
    ).toBe(true);
    const headers = new Headers(test.requests[0]?.headers);
    expect(headers.get("apns-push-type")).toBe("background");
    expect(headers.get("apns-priority")).toBe("5");
    expect(JSON.parse(String(test.requests[0]?.body))).toEqual({
      aps: { "content-available": 1 },
      verification: { device_id: account.target.deviceId, code: "test-verification-code" },
    });
    test.setStatus(503);
    expect(await test.gateway.sendDeviceVerification({ ...account.target, code: "new-code" })).toBe(
      false,
    );
    expect(test.jobs).toEqual([]);
  });

  it("指数バックオフの jitter は0〜10%で、基準を30分に制限する", () => {
    expect(retryDelay(900, 1, () => 0)).toBe(900);
    expect(retryDelay(900, 2, () => 0.5)).toBe(1890);
    expect(retryDelay(900, 10, () => 0.5)).toBe(1890);
  });
  it.each(["old_timestamp", "new_registration"] as const)(
    "410 の %s で新しい登録を止めない",
    async (scenario) => {
      const account = await accountWithDevice();
      const test = await setup();
      await test.gateway.push(account.target, notification(), {
        signal: new AbortController().signal,
      });
      test.send.mockImplementationOnce(async () => {
        if (scenario === "new_registration") {
          const sealed = await sealDeviceToken(
            await loadDeviceTokenKeys(env),
            account.target.apnsToken,
            {
              installationId: account.owner.installationId,
              apnsEnvironment: "sandbox",
              topic: TOPIC,
            },
          );
          await registerDeviceToken(createDb(env.DB), {
            ...account.owner,
            apnsTokenCiphertext: sealed.ciphertext,
            tokenFingerprint: sealed.fingerprint,
            apnsEnvironment: "sandbox",
            topic: TOPIC,
            challenge: consumedChallenge(),
          });
          await verifyDevice(createDb(env.DB), account.owner, account.target.deviceId);
        }
        return new Response(
          JSON.stringify({
            reason: "Unregistered",
            timestamp: scenario === "old_timestamp" ? Date.now() - 3600_000 : Date.now() + 1000,
          }),
          { status: 410 },
        );
      });
      await consume(test.gateway, test.jobs[0]);
      expect(await listActiveDevices(createDb(env.DB), account.owner.accountId)).toHaveLength(1);
    },
  );
});
