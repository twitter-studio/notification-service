import { env } from "cloudflare:workers";
import { createDb, revokeRelayCredential } from "@notification-service/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { requireRelayCredential } from "../src/middleware/relay";
import { enrollNewDevice } from "./helpers/api";

function appWithRelayRoute() {
  const app = createApp();
  app.get("/v1/test/relay", requireRelayCredential, (c) => c.json(c.get("relayCredential")));
  return app;
}

async function requestWith(authorization?: string) {
  return appWithRelayRoute().request(
    "https://notification.test/v1/test/relay",
    { headers: authorization === undefined ? {} : { Authorization: authorization } },
    env,
  );
}

describe("中継の資格情報の確かめ", () => {
  it("使える資格情報なら、そのアカウントと資格情報を置いて通し、使った時刻を残す", async () => {
    const { enrolled } = await enrollNewDevice();

    const response = await requestWith(`Bearer ${enrolled.relay_secret}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: enrolled.relay_credential_id,
      accountId: enrolled.account_id,
    });
    const row = await env.DB.prepare("SELECT last_used_at FROM relay_credentials WHERE id = ?")
      .bind(enrolled.relay_credential_id)
      .first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).not.toBeNull();
  });

  it("ない、形が違う、セッションのトークン、知らない、取り消した、期限切れ、止めたアカウントのものは 401", async () => {
    const valid = await enrollNewDevice();
    const revoked = await enrollNewDevice();
    await revokeRelayCredential(createDb(env.DB), {
      accountId: revoked.enrolled.account_id,
      credentialId: revoked.enrolled.relay_credential_id ?? "",
    });
    const expired = await enrollNewDevice();
    await env.DB.prepare("UPDATE relay_credentials SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expired.enrolled.relay_credential_id)
      .run();
    const disabled = await enrollNewDevice();
    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(disabled.enrolled.account_id)
      .run();

    for (const authorization of [
      undefined,
      "Bearer not-a-token",
      `Basic ${valid.enrolled.relay_secret}`,
      `Bearer ${valid.enrolled.session.token}`,
      `Bearer tsr_${"A".repeat(43)}`,
      `Bearer ${revoked.enrolled.relay_secret}`,
      `Bearer ${expired.enrolled.relay_secret}`,
      `Bearer ${disabled.enrolled.relay_secret}`,
    ]) {
      const response = await requestWith(authorization);
      expect(response.status, String(authorization)).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    }
  });
});
