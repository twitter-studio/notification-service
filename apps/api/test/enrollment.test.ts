import { env, exports } from "cloudflare:workers";
import {
  createDb,
  findActiveRelayCredential,
  findActiveSession,
  revokeInstallation,
} from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { createApp, MAX_BODY_BYTES } from "../src/app";
import { hashBearerToken } from "../src/security/bearer";
import { enrollmentMessage, sessionMessage } from "../src/security/installation-key";
import { newDeviceKey } from "./helpers/device-key";

const INVITE = "test-invite-code";

async function post(path: string, body: unknown) {
  return exports.default.fetch(`https://notification.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function challenge(purpose: "enroll" | "session") {
  const response = await post("/v1/enrollments/challenge", { purpose });
  expect(response.status).toBe(200);
  return (await response.json<{ challenge: string }>()).challenge;
}

async function enroll(
  device: Awaited<ReturnType<typeof newDeviceKey>>,
  overrides: Record<string, string> = {},
) {
  const issued = overrides.challenge ?? (await challenge("enroll"));
  return post("/v1/enrollments", {
    challenge: issued,
    public_key: device.publicKey,
    signature:
      overrides.signature ?? (await device.sign(enrollmentMessage(issued, device.publicKey))),
    invite_code: overrides.invite_code ?? INVITE,
  });
}

type Enrolled = {
  account_id: string;
  installation_id: string;
  session: { token: string; expires_at: string };
  relay_secret?: string;
};

async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  return response.json<{ title: string; detail?: string }>();
}

describe("端末の登録", () => {
  it("署名したチャレンジで登録すると、アカウント、セッション、1 回だけ見せる中継の資格情報を返す", async () => {
    const device = await newDeviceKey();

    const response = await enroll(device);

    expect(response.status).toBe(201);
    const body = await response.json<Enrolled>();
    expect(body.session.token).toMatch(/^tss_[A-Za-z0-9_-]{43}$/);
    expect(body.relay_secret).toMatch(/^tsr_[A-Za-z0-9_-]{43}$/);
    const db = createDb(env.DB);
    expect(
      (await findActiveRelayCredential(db, await hashBearerToken(body.relay_secret ?? "")))
        ?.accountId,
    ).toBe(body.account_id);
    expect(
      (await findActiveSession(db, await hashBearerToken(body.session.token)))?.installationId,
    ).toBe(body.installation_id);
  });

  it("DB には、セッションと中継の資格情報の平文を置かない", async () => {
    const body = await (await enroll(await newDeviceKey())).json<Enrolled>();

    for (const [table, column] of [
      ["sessions", "token_hash"],
      ["relay_credentials", "secret_hash"],
    ] as const) {
      const rows = await env.DB.prepare(`SELECT ${column} AS value FROM ${table}`).all<{
        value: string;
      }>();
      for (const row of rows.results) {
        expect(row.value).not.toBe(body.session.token);
        expect(row.value).not.toBe(body.relay_secret);
      }
    }
  });

  it("使ったチャレンジは、ほかの鍵の登録に使い回せない", async () => {
    const issued = await challenge("enroll");
    expect((await enroll(await newDeviceKey(), { challenge: issued })).status).toBe(201);

    await expectProblem(await enroll(await newDeviceKey(), { challenge: issued }), 409);
  });

  it("同じ鍵と同じチャレンジの 2 回目は、409 で拒む", async () => {
    const device = await newDeviceKey();
    const issued = await challenge("enroll");
    const signature = await device.sign(enrollmentMessage(issued, device.publicKey));
    await enroll(device, { challenge: issued, signature });

    await expectProblem(await enroll(device, { challenge: issued, signature }), 409);
  });

  it("同じ鍵で新しいチャレンジから登録し直すと、前のアカウントのセッションだけを返し、資格情報は返さない", async () => {
    const device = await newDeviceKey();
    const first = await (await enroll(device)).json<Enrolled>();

    const retried = await enroll(device);

    expect(retried.status).toBe(200);
    const body = await retried.json<Enrolled>();
    expect(body.account_id).toBe(first.account_id);
    expect(body.relay_secret).toBeUndefined();
    expect(body.session.token).not.toBe(first.session.token);
  });

  it("招待のコードが違う、または登録を受け付けていないときは、403", async () => {
    await expectProblem(await enroll(await newDeviceKey(), { invite_code: "wrong" }), 403);

    const device = await newDeviceKey();
    const issued = await challenge("enroll");
    const closed = await createApp().request(
      "https://notification.test/v1/enrollments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge: issued,
          public_key: device.publicKey,
          signature: await device.sign(enrollmentMessage(issued, device.publicKey)),
          invite_code: "",
        }),
      },
      { ...env, ENROLLMENT_INVITE_CODE: "" },
    );
    await expectProblem(closed, 403);
  });

  it("署名が違う (ほかの鍵、ほかの文、セッション用のチャレンジ) ときは、401", async () => {
    const device = await newDeviceKey();
    const other = await newDeviceKey();
    const issued = await challenge("enroll");

    await expectProblem(
      await enroll(device, {
        challenge: issued,
        signature: await other.sign(enrollmentMessage(issued, device.publicKey)),
      }),
      401,
    );
    await expectProblem(
      await enroll(device, { signature: await device.sign("something else") }),
      401,
    );
    const sessionChallenge = await challenge("session");
    await expectProblem(
      await enroll(device, {
        challenge: sessionChallenge,
        signature: await device.sign(enrollmentMessage(sessionChallenge, device.publicKey)),
      }),
      401,
    );
  });

  it("公開鍵の形が違う、入力が足りないときは 422、本文が大きすぎるときは 413", async () => {
    const issued = await challenge("enroll");
    await expectProblem(
      await post("/v1/enrollments", {
        challenge: issued,
        public_key: "AAAA",
        signature: "AAAA",
        invite_code: INVITE,
      }),
      422,
    );
    await expectProblem(await post("/v1/enrollments", { challenge: issued }), 422);
    await expectProblem(await post("/v1/enrollments/challenge", { purpose: "other" }), 422);
    await expectProblem(
      await post("/v1/enrollments", { padding: "x".repeat(MAX_BODY_BYTES) }),
      413,
    );
  });
});

describe("セッションの作り直し", () => {
  it("インストールの鍵で署名すると、新しいセッションを返す", async () => {
    const device = await newDeviceKey();
    const enrolled = await (await enroll(device)).json<Enrolled>();
    const issued = await challenge("session");

    const response = await post("/v1/sessions", {
      installation_id: enrolled.installation_id,
      challenge: issued,
      signature: await device.sign(sessionMessage(issued, enrolled.installation_id)),
    });

    expect(response.status).toBe(201);
    const body = await response.json<{ session: { token: string } }>();
    expect(
      (await findActiveSession(createDb(env.DB), await hashBearerToken(body.session.token)))
        ?.accountId,
    ).toBe(enrolled.account_id);
  });

  it("ほかの鍵の署名、ないインストール、取り消したインストールは、同じ 401 で拒む", async () => {
    const device = await newDeviceKey();
    const enrolled = await (await enroll(device)).json<Enrolled>();
    const other = await newDeviceKey();

    const attempt = async (signer: typeof device, installationId: string) => {
      const issued = await challenge("session");
      return post("/v1/sessions", {
        installation_id: installationId,
        challenge: issued,
        signature: await signer.sign(sessionMessage(issued, installationId)),
      });
    };

    const wrongKey = await expectProblem(await attempt(other, enrolled.installation_id), 401);
    const missing = await expectProblem(await attempt(device, crypto.randomUUID()), 401);
    expect(missing.detail).toBe(wrongKey.detail);

    await revokeInstallation(createDb(env.DB), {
      accountId: enrolled.account_id,
      installationId: enrolled.installation_id,
    });
    await expectProblem(await attempt(device, enrolled.installation_id), 401);
  });

  it("同じチャレンジでセッションを 2 回作れない", async () => {
    const device = await newDeviceKey();
    const enrolled = await (await enroll(device)).json<Enrolled>();
    const issued = await challenge("session");
    const body = {
      installation_id: enrolled.installation_id,
      challenge: issued,
      signature: await device.sign(sessionMessage(issued, enrolled.installation_id)),
    };
    expect((await post("/v1/sessions", body)).status).toBe(201);

    await expectProblem(await post("/v1/sessions", body), 409);
  });
});
