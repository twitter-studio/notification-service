import { env } from "cloudflare:workers";
import { createDb, findActiveRelayCredential, revokeInstallation } from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { hashBearerToken } from "../src/security/bearer";
import { relayCredentialMessage, sessionMessage } from "../src/security/installation-key";
import {
  call,
  type DeviceKey,
  type Enrolled,
  enrollNewDevice,
  expectProblem,
  issueTestChallenge,
} from "./helpers/api";
import { newDeviceKey } from "./helpers/device-key";

type Rotated = { relay_credential_id: string; relay_secret: string };

async function rotate(
  device: DeviceKey,
  enrolled: Enrolled,
  overrides: { challenge?: string; signature?: string; token?: string } = {},
) {
  const challenge = overrides.challenge ?? (await issueTestChallenge("relay_credential"));
  return call("POST", "/v1/relay-credentials/rotate", {
    token: overrides.token ?? enrolled.session.token,
    body: {
      challenge,
      signature:
        overrides.signature ??
        (await device.sign(relayCredentialMessage(challenge, enrolled.installation_id))),
    },
  });
}

async function activeAccountOf(secret: string | undefined) {
  return (await findActiveRelayCredential(createDb(env.DB), await hashBearerToken(secret ?? "")))
    ?.accountId;
}

describe("中継の資格情報の入れ替え", () => {
  it("セッションと端末の鍵の署名で入れ替えると、新しい秘密を返し、前のものは使えなくなる", async () => {
    const { device, enrolled } = await enrollNewDevice();

    const response = await rotate(device, enrolled);

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<Rotated>();
    expect(body.relay_secret).toMatch(/^tsr_[A-Za-z0-9_-]{43}$/);
    expect(body.relay_credential_id).not.toBe(enrolled.relay_credential_id);
    expect(await activeAccountOf(body.relay_secret)).toBe(enrolled.account_id);
    expect(await activeAccountOf(enrolled.relay_secret)).toBeUndefined();
  });

  it("続けて入れ替えると、使えるのは最後のものだけ", async () => {
    const { device, enrolled } = await enrollNewDevice();

    const first = await (await rotate(device, enrolled)).json<Rotated>();
    const second = await (await rotate(device, enrolled)).json<Rotated>();

    expect(await activeAccountOf(first.relay_secret)).toBeUndefined();
    expect(await activeAccountOf(second.relay_secret)).toBe(enrolled.account_id);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS count FROM relay_credentials WHERE account_id = ? AND revoked_at IS NULL",
    )
      .bind(enrolled.account_id)
      .first<{ count: number }>();
    expect(rows?.count).toBe(1);
  });

  it("セッションだけ、ほかの鍵の署名、ほかの用途のチャレンジや文では、入れ替えられない", async () => {
    const { device, enrolled } = await enrollNewDevice();
    const other = await newDeviceKey();

    const noSession = await rotate(device, enrolled, { token: "" });
    expect(noSession.headers.get("WWW-Authenticate")).toContain("Bearer");
    await expectProblem(noSession, 401);
    const challenge = await issueTestChallenge("relay_credential");
    await expectProblem(
      await rotate(device, enrolled, {
        challenge,
        signature: await other.sign(relayCredentialMessage(challenge, enrolled.installation_id)),
      }),
      401,
    );
    const sessionChallenge = await issueTestChallenge("session");
    await expectProblem(
      await rotate(device, enrolled, {
        challenge: sessionChallenge,
        signature: await device.sign(
          relayCredentialMessage(sessionChallenge, enrolled.installation_id),
        ),
      }),
      401,
    );
    const another = await issueTestChallenge("relay_credential");
    await expectProblem(
      await rotate(device, enrolled, {
        challenge: another,
        signature: await device.sign(sessionMessage(another, enrolled.installation_id)),
      }),
      401,
    );
    // どれも、前の資格情報を取り消していない。
    expect(await activeAccountOf(enrolled.relay_secret)).toBe(enrolled.account_id);
  });

  it("同じチャレンジでは 2 回入れ替えられない", async () => {
    const { device, enrolled } = await enrollNewDevice();
    const challenge = await issueTestChallenge("relay_credential");
    const signature = await device.sign(
      relayCredentialMessage(challenge, enrolled.installation_id),
    );
    expect((await rotate(device, enrolled, { challenge, signature })).status).toBe(201);

    await expectProblem(await rotate(device, enrolled, { challenge, signature }), 409);
  });

  it("ほかのアカウントのセッションでは、そのアカウントの資格情報を入れ替えるだけで、ほかのアカウントには触れない", async () => {
    const alice = await enrollNewDevice();
    const bob = await enrollNewDevice();

    const response = await rotate(alice.device, alice.enrolled);

    expect(response.status).toBe(201);
    expect(await activeAccountOf(bob.enrolled.relay_secret)).toBe(bob.enrolled.account_id);
  });

  it("入れ替えすぎると 429", async () => {
    const { device, enrolled } = await enrollNewDevice();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      statuses.push((await rotate(device, enrolled)).status);
    }

    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("中継の資格情報の取り消し", () => {
  it("自分のアカウントの資格情報を取り消すと 204 で、もう使えない", async () => {
    const { enrolled } = await enrollNewDevice();

    const response = await call("DELETE", `/v1/relay-credentials/${enrolled.relay_credential_id}`, {
      token: enrolled.session.token,
    });

    expect(response.status).toBe(204);
    expect(await activeAccountOf(enrolled.relay_secret)).toBeUndefined();
  });

  it("ほかのアカウントのもの、取り消し済み、ないものは 404 で、ほかのアカウントのものは取り消さない", async () => {
    const alice = await enrollNewDevice();
    const bob = await enrollNewDevice();
    const revoke = (id: string | undefined) =>
      call("DELETE", `/v1/relay-credentials/${id}`, { token: alice.enrolled.session.token });

    await expectProblem(await revoke(bob.enrolled.relay_credential_id), 404);
    expect(await activeAccountOf(bob.enrolled.relay_secret)).toBe(bob.enrolled.account_id);
    expect((await revoke(alice.enrolled.relay_credential_id)).status).toBe(204);
    await expectProblem(await revoke(alice.enrolled.relay_credential_id), 404);
    await expectProblem(await revoke(crypto.randomUUID()), 404);
    await expectProblem(await revoke("not-a-uuid"), 422);
  });

  it("セッションがない、取り消したインストールのセッションでは、取り消せない", async () => {
    const { enrolled } = await enrollNewDevice();
    const path = `/v1/relay-credentials/${enrolled.relay_credential_id}`;

    await expectProblem(await call("DELETE", path), 401);
    await revokeInstallation(createDb(env.DB), {
      accountId: enrolled.account_id,
      installationId: enrolled.installation_id,
    });
    await expectProblem(await call("DELETE", path, { token: enrolled.session.token }), 401);
  });
});
