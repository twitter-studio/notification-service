import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { enrollmentMessage } from "../../src/security/installation-key";
import { newDeviceKey } from "./device-key";
import { jsonHeaders } from "./http";

/** テストだけの招待のコード (vitest.config.ts と同じ)。 */
export const INVITE = "test-invite-code-0123456789";

export type DeviceKey = Awaited<ReturnType<typeof newDeviceKey>>;

export type Enrolled = {
  account_id: string;
  installation_id: string;
  session: { token: string; expires_at: string };
  relay_secret?: string;
  relay_credential_id?: string;
};

/** API を呼ぶ。`token` を渡すと、`Authorization: Bearer` に付ける。 */
export async function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
) {
  const headers = { ...jsonHeaders(), ...options.headers };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  return exports.default.fetch(`https://notification.test${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

export async function issueTestChallenge(purpose: "enroll" | "session" | "relay_credential") {
  const response = await call("POST", "/v1/enrollments/challenge", { body: { purpose } });
  expect(response.status).toBe(200);
  return (await response.json<{ challenge: string }>()).challenge;
}

/** 新しい端末の鍵で登録する。 */
export async function enrollNewDevice(): Promise<{ device: DeviceKey; enrolled: Enrolled }> {
  const device = await newDeviceKey();
  const challenge = await issueTestChallenge("enroll");
  const response = await call("POST", "/v1/enrollments", {
    body: {
      challenge,
      public_key: device.publicKey,
      signature: await device.sign(enrollmentMessage(challenge, device.publicKey)),
      invite_code: INVITE,
    },
  });
  expect(response.status).toBe(201);
  return { device, enrolled: await response.json<Enrolled>() };
}

export async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  return response.json<{ title: string; detail?: string }>();
}
