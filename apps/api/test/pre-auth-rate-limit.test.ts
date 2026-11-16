import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { requireRelayCredential } from "../src/middleware/relay";
import { requireSession } from "../src/middleware/session";
import { authenticationSourceKey } from "../src/security/rate-limit";
import { enrollNewDevice } from "./helpers/api";
import { expectLimitReached, outcomeOf } from "./helpers/rate-limit";

function app() {
  const app = createApp();
  app.get("/test/relay", requireRelayCredential, (c) => c.json(c.get("relayCredential")));
  app.get("/test/session", requireSession, (c) => c.json(c.get("session")));
  return app;
}

describe("認証前の回数制限", () => {
  it.each(["relay", "session"])("%s: 上限ではD1へ到達せず429で待機を求める", async (kind) => {
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be accessed");
    });
    const limit = vi.fn(async () => ({ success: false }));
    const response = await app().request(
      `https://notification.test/test/${kind}`,
      {
        headers: {
          Authorization: `Bearer ${kind === "relay" ? "tsr" : "tss"}_${"A".repeat(43)}`,
          "CF-Connecting-IP": "2001:db8:1:2::123",
        },
      },
      { ...env, AUTH_RATE_LIMITER: { limit }, DB: { ...env.DB, prepare } },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(prepare).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith({ key: "ip6:2001:db8:1:2::/64" });
  });

  it.each(["relay", "session"])(
    "%s: ランダムな資格情報の繰り返しを実際のbindingで止める",
    async (kind) => {
      const ip = kind === "relay" ? "192.0.2.185" : "192.0.2.186";
      const headers = {
        Authorization: `Bearer ${kind === "relay" ? "tsr" : "tss"}_${"A".repeat(43)}`,
        "CF-Connecting-IP": ip,
      };
      await expectLimitReached(120, async () =>
        outcomeOf(
          (await app().request(`https://notification.test/test/${kind}`, { headers }, env)).status,
          401,
        ),
      );
      const prepare = vi.fn(() => {
        throw new Error("D1 must not be accessed");
      });
      const response = await app().request(
        `https://notification.test/test/${kind}`,
        { headers },
        { ...env, DB: { ...env.DB, prepare } },
      );
      expect(response.status).toBe(429);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("cross-zone Worker の枠を所有 zone ごとに分け、通常の接続元はヘッダーで変えない", async () => {
    const first = "first.workers.dev";
    const second = "second.workers.dev";
    const headers = (zone: string, ip = "2a06:98c0:3600::103") => ({
      "CF-Connecting-IP": ip,
      "CF-Worker": zone,
      Authorization: `Bearer tsr_${"A".repeat(43)}`,
    });
    const key = (zone: string, ip?: string) =>
      authenticationSourceKey(
        new Request("https://notification.test", { headers: headers(zone, ip) }),
      );
    expect(key(first)).toBe(`worker:${first}`);
    expect(key(second)).toBe(`worker:${second}`);
    expect(key(first, "2A06:98C0:3600:0:0:0:0:0103")).toBe(`worker:${first}`);
    expect(key(first, "192.0.2.84")).toBe("ip:192.0.2.84");
    expect(key(second, "192.0.2.84")).toBe("ip:192.0.2.84");
    await expectLimitReached(120, async () =>
      outcomeOf(
        (
          await app().request(
            "https://notification.test/test/relay",
            { headers: headers(first) },
            env,
          )
        ).status,
        401,
      ),
    );
    expect(
      (
        await app().request(
          "https://notification.test/test/relay",
          { headers: headers(second) },
          env,
        )
      ).status,
    ).toBe(401);
  });

  it("正常なセッションと中継資格情報は、それぞれのアカウントで通る", async () => {
    const first = await enrollNewDevice();
    const second = await enrollNewDevice();
    const limit = vi.fn(async () => ({ success: true }));
    for (const { enrolled } of [first, second]) {
      for (const [kind, token] of [
        ["relay", enrolled.relay_secret],
        ["session", enrolled.session.token],
      ]) {
        const response = await app().request(
          `https://notification.test/test/${kind}`,
          {
            headers: { Authorization: `Bearer ${token}`, "CF-Connecting-IP": "192.0.2.84" },
          },
          { ...env, AUTH_RATE_LIMITER: { limit } },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ accountId: enrolled.account_id });
      }
    }
    expect(limit).toHaveBeenCalledTimes(4);
    expect(limit).toHaveBeenCalledWith({ key: "ip:192.0.2.84" });
  });
});
