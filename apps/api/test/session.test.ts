import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { requireSession } from "../src/middleware/session";
import { enrollmentMessage } from "../src/security/installation-key";
import { newDeviceKey } from "./helpers/device-key";
import { jsonHeaders } from "./helpers/http";

function appWithProtectedRoute() {
  const app = createApp();
  app.get("/v1/test/me", requireSession, (c) => c.json(c.get("session")));
  return app;
}

async function enrolledSession() {
  const app = createApp();
  const device = await newDeviceKey();
  const challenge = (
    await (
      await app.request(
        "https://notification.test/v1/enrollments/challenge",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ purpose: "enroll" }),
        },
        env,
      )
    ).json<{ challenge: string }>()
  ).challenge;
  const response = await app.request(
    "https://notification.test/v1/enrollments",
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        challenge,
        public_key: device.publicKey,
        signature: await device.sign(enrollmentMessage(challenge, device.publicKey)),
        invite_code: "test-invite-code-0123456789",
      }),
    },
    env,
  );
  return response.json<{
    account_id: string;
    installation_id: string;
    session: { token: string };
  }>();
}

describe("セッションの確かめ", () => {
  it("使えるセッションなら、セッションのアカウントとインストールを置いて通す", async () => {
    const enrolled = await enrolledSession();

    const response = await appWithProtectedRoute().request(
      "https://notification.test/v1/test/me",
      { headers: { Authorization: `Bearer ${enrolled.session.token}` } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accountId: enrolled.account_id,
      installationId: enrolled.installation_id,
    });
  });

  it("トークンがない、形が違う、知らない、期限切れ、止めたアカウントのものは 401 で、WWW-Authenticate を付ける", async () => {
    const enrolled = await enrolledSession();
    const expired = await enrolledSession();
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE account_id = ?")
      .bind(Date.now() - 1, expired.account_id)
      .run();
    const disabled = await enrolledSession();
    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(disabled.account_id)
      .run();

    for (const authorization of [
      undefined,
      "Bearer not-a-token",
      `Basic ${enrolled.session.token}`,
      `Bearer tss_${"A".repeat(43)}`,
      `Bearer ${expired.session.token}`,
      `Bearer ${disabled.session.token}`,
    ]) {
      const response = await appWithProtectedRoute().request(
        "https://notification.test/v1/test/me",
        { headers: authorization === undefined ? {} : { Authorization: authorization } },
        env,
      );
      expect(response.status, String(authorization)).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    }
  });
});
