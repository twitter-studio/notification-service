import { env } from "cloudflare:workers";
import {
  createDb,
  createSession,
  deleteAccount,
  findActiveSession,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashBearerToken, newBearerToken } from "../src/security/bearer";
import { challengeKeyFromEnv, issueChallenge } from "../src/security/challenge";
import { toBase64Url } from "../src/security/encoding";
import { enrollmentMessage, sessionMessage } from "../src/security/installation-key";
import { newDeviceKey } from "./helpers/device-key";
import { jsonHeaders } from "./helpers/http";
import { fixture, policy } from "./security/app-attest/fixtures";

async function setup() {
  const device = await newDeviceKey();
  const challenge = (await issueChallenge(await challengeKeyFromEnv(env), "enroll")).challenge;
  const test = await fixture({
    clientData: new TextEncoder().encode(enrollmentMessage(challenge, device.publicKey)),
  });
  const app = createApp({ appAttestVerifier: test.verifier });
  const bindings = { ...env, APP_ATTEST_POLICY: JSON.stringify({ ...policy, mode: "required" }) };
  const post = (path: string, body: unknown, config = bindings) =>
    app.request(
      path,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      },
      config,
    );
  const proof = {
    kind: "attestation",
    key_id: toBase64Url(test.input.keyId),
    data: toBase64Url(test.input.object),
  };
  const enrollment = {
    challenge,
    public_key: device.publicKey,
    signature: await device.sign(enrollmentMessage(challenge, device.publicKey)),
    app_attest: proof,
  };
  return { test, device, post, proof, enrollment, bindings };
}
type Enrolled = { account_id: string; installation_id: string; session: { token: string } };

describe("App Attestを必要とする登録とセッション", () => {
  it("招待コードなしで実署名を検証し、receiptは暗号文だけを保存する", async () => {
    const t = await setup();
    const response = await t.post("/v1/enrollments", t.enrollment);
    expect(response.status).toBe(201);
    const value = await response.json<Enrolled>();
    const row =
      await env.DB.prepare(`SELECT a.*, i.attestation_state FROM installation_attestations a
      JOIN installations i ON i.id = a.installation_id WHERE a.installation_id = ?1`)
        .bind(value.installation_id)
        .first();
    expect(row).toMatchObject({
      counter: 0,
      attestation_state: "verified",
      key_id: t.proof.key_id,
    });
    expect(row?.receipt_ciphertext).toMatch(/^ar1\./);
    expect(JSON.stringify(row)).not.toContain(toBase64Url(t.test.receipt));
    const replay = await t.post("/v1/enrollments", t.enrollment);
    expect([401, 409]).toContain(replay.status);
    await deleteAccount(createDb(env.DB), { accountId: value.account_id });
    expect(
      await env.DB.prepare("SELECT 1 FROM installation_attestations WHERE installation_id = ?1")
        .bind(value.installation_id)
        .first(),
    ).toBeNull();
  });
  it("証明を省略した登録と、不正な証明の招待コードへのfallbackを拒む", async () => {
    const t = await setup();
    expect(
      (await t.post("/v1/enrollments", { ...t.enrollment, app_attest: undefined })).status,
    ).toBe(401);
    expect(
      (
        await t.post(
          "/v1/enrollments",
          {
            ...t.enrollment,
            invite_code: "test-invite-code-0123456789",
            app_attest: { ...t.proof, data: "AA" },
          },
          { ...t.bindings, APP_ATTEST_POLICY: JSON.stringify({ ...policy, mode: "invite_only" }) },
        )
      ).status,
    ).toBe(401);
  });
  it("セッション更新にはassertionを必要とし、同じcounterの並行要求は1件だけ成功する", async () => {
    const t = await setup();
    const response = await t.post("/v1/enrollments", t.enrollment);
    expect(response.status).toBe(201);
    const account = await response.json<Enrolled>();
    const challenge = (await issueChallenge(await challengeKeyFromEnv(env), "session")).challenge;
    const message = sessionMessage(challenge, account.installation_id);
    const body = {
      installation_id: account.installation_id,
      challenge,
      signature: await t.device.sign(message),
      app_attest: {
        ...t.proof,
        kind: "assertion",
        data: toBase64Url(await t.test.assertion(1, new TextEncoder().encode(message))),
      },
    };
    expect((await t.post("/v1/sessions", { ...body, app_attest: undefined })).status).toBe(401);
    const renewed = await t.post("/v1/sessions", body);
    expect(renewed.status).toBe(201);
    expect((await t.post("/v1/sessions", body)).status).toBe(401);
    const db = createDb(env.DB);
    const nextSession = async () => ({
      tokenHash: await hashBearerToken(newBearerToken("session")),
      expiresAt: new Date(Date.now() + 60000),
    });
    const outcomes = await Promise.all(
      [1, 2].map(async () =>
        createSession(db, {
          accountId: account.account_id,
          installationId: account.installation_id,
          challenge: { nonce: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60000) },
          session: await nextSession(),
          attestation: { kind: "assertion", keyId: t.proof.key_id, previousCounter: 1, counter: 2 },
        }),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });
  it("招待で作った登録を確認済みに昇格し、昇格前のセッションを失効させる", async () => {
    const t = await setup();
    const invited = await t.post(
      "/v1/enrollments",
      { ...t.enrollment, app_attest: undefined, invite_code: "test-invite-code-0123456789" },
      { ...t.bindings, APP_ATTEST_POLICY: JSON.stringify({ ...policy, mode: "invite_only" }) },
    );
    expect(invited.status).toBe(201);
    const old = await invited.json<Enrolled>();
    expect(
      await findActiveSession(
        createDb(env.DB),
        await hashBearerToken(old.session.token),
        new Date(),
        policy,
      ),
    ).toBeUndefined();
    const challenge = (await issueChallenge(await challengeKeyFromEnv(env), "session")).challenge;
    const message = sessionMessage(challenge, old.installation_id);
    const upgraded = await fixture({ clientData: new TextEncoder().encode(message) });
    const app = createApp({ appAttestVerifier: upgraded.verifier });
    const response = await app.request(
      "/v1/sessions",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          installation_id: old.installation_id,
          challenge,
          signature: await t.device.sign(message),
          app_attest: {
            kind: "attestation",
            key_id: toBase64Url(upgraded.input.keyId),
            data: toBase64Url(upgraded.input.object),
          },
        }),
      },
      t.bindings,
    );
    expect(response.status).toBe(201);
    expect(
      await findActiveSession(createDb(env.DB), await hashBearerToken(old.session.token)),
    ).toBeUndefined();
  });
});

it("assertion検証中に削除が競合しても、新しい未確認アカウントを作らない", async () => {
  const t = await setup();
  const created = await t.post("/v1/enrollments", t.enrollment);
  const account = await created.json<Enrolled>();
  const challenge = (await issueChallenge(await challengeKeyFromEnv(env), "enroll")).challenge;
  const message = enrollmentMessage(challenge, t.device.publicKey);
  const assertion = await t.test.assertion(1, new TextEncoder().encode(message));
  const app = createApp({
    appAttestVerifier: {
      ...t.test.verifier,
      assertion: async (input) => {
        const counter = await t.test.verifier.assertion(input);
        await deleteAccount(createDb(env.DB), { accountId: account.account_id });
        return counter;
      },
    },
  });
  const response = await app.request(
    "/v1/enrollments",
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        challenge,
        public_key: t.device.publicKey,
        signature: await t.device.sign(message),
        app_attest: { ...t.proof, kind: "assertion", data: toBase64Url(assertion) },
      }),
    },
    t.bindings,
  );
  expect(response.status).toBe(401);
  expect(
    await env.DB.prepare("SELECT 1 FROM installations WHERE public_key = ?1")
      .bind(t.device.publicKey)
      .first(),
  ).toBeNull();
});
it("端末鍵の署名が正しくても、未登録のApp Attest鍵のassertionは428で初回証明を求める", async () => {
  const t = await setup();
  const response = await t.post("/v1/enrollments", {
    ...t.enrollment,
    app_attest: { ...t.proof, kind: "assertion", data: toBase64Url(await t.test.assertion(1)) },
  });
  expect(response.status).toBe(428);
});

it("失ったApp Attest鍵を新しい初回証明で置き換え、旧セッションと旧鍵を無効にする", async () => {
  const t = await setup();
  const response = await t.post("/v1/enrollments", t.enrollment);
  const account = await response.json<Enrolled>();
  const challenge = (await issueChallenge(await challengeKeyFromEnv(env), "session")).challenge;
  const message = sessionMessage(challenge, account.installation_id);
  const replacement = await fixture({ clientData: new TextEncoder().encode(message) });
  const app = createApp({ appAttestVerifier: replacement.verifier });
  const replaced = await app.request(
    "/v1/sessions",
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        installation_id: account.installation_id,
        challenge,
        signature: await t.device.sign(message),
        app_attest: {
          kind: "attestation",
          key_id: toBase64Url(replacement.input.keyId),
          data: toBase64Url(replacement.input.object),
        },
      }),
    },
    t.bindings,
  );
  expect(replaced.status).toBe(201);
  const row = await env.DB.prepare(
    "SELECT key_id, counter FROM installation_attestations WHERE installation_id = ?1",
  )
    .bind(account.installation_id)
    .first();
  expect(row).toEqual({ key_id: toBase64Url(replacement.input.keyId), counter: 0 });
  expect(
    await findActiveSession(createDb(env.DB), await hashBearerToken(account.session.token)),
  ).toBeUndefined();
});

it("鍵の置換がサーバーへ届く前に切断した場合は428で初回証明の再取得を求める", async () => {
  const t = await setup();
  const enrolled = await t.post("/v1/enrollments", t.enrollment);
  expect(enrolled.status).toBe(201);
  const challenge = (await issueChallenge(await challengeKeyFromEnv(env), "enroll")).challenge;
  const message = enrollmentMessage(challenge, t.device.publicKey);
  const unsent = await fixture({ clientData: new TextEncoder().encode(message) });
  const response = await t.post("/v1/enrollments", {
    challenge,
    public_key: t.device.publicKey,
    signature: await t.device.sign(message),
    app_attest: {
      kind: "assertion",
      key_id: toBase64Url(unsent.input.keyId),
      data: toBase64Url(await unsent.assertion(1)),
    },
  });
  expect(response.status).toBe(428);
  const row = await env.DB.prepare("SELECT key_id FROM installation_attestations WHERE key_id = ?1")
    .bind(t.proof.key_id)
    .first();
  expect(row?.key_id).toBe(t.proof.key_id);
});
