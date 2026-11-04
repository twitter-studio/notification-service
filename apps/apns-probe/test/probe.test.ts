import { describe, expect, it, vi } from "vitest";
import { createProbe } from "../src/app";

const token = "01".repeat(32);
const config = () => ({
  APNS_PROVIDER_TOKEN: "test.provider.token",
  PROBE_AUTH_TOKEN: "a".repeat(43),
  PROBE_EXPIRES_AT: new Date(Date.now() + 600_000).toISOString(),
});
const request = (
  body = JSON.stringify({ device_token: token }),
  auth = `Bearer ${"a".repeat(43)}`,
) => ({
  method: "POST",
  headers: { Authorization: auth, "Content-Type": "application/json" },
  body,
});

describe("sandbox APNs の到達確認", () => {
  it("送信先・topic・payload は固定し、200でも端末への到達やHTTPの版を断定しない", async () => {
    const id = crypto.randomUUID();
    const send = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 200, headers: { "apns-id": id } }),
    );
    const response = await createProbe(send).request(
      "https://probe.test/probe",
      request(),
      config(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(`https://api.sandbox.push.apple.com/3/device/${token}`);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      headers: {
        "apns-topic": "com.twitter-studio.Tweetbot",
        "apns-push-type": "alert",
        "apns-expiration": "0",
      },
    });
    expect(await response.json()).toMatchObject({
      kind: "apns_response",
      status: 200,
      apns_id: id,
      reason: null,
      http_protocol: "not_exposed",
      cpu_ms: null,
    });
  });

  it.each(["", "Bearer wrong", `Bearer ${"b".repeat(43)}`])(
    "認証に失敗した要求はAPNsへ送らない",
    async (authorization) => {
      const send = vi.fn<typeof fetch>();
      const response = await createProbe(send).request(
        "https://probe.test/probe",
        request(undefined, authorization),
        config(),
      );
      expect(response.status).toBe(401);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 16 * 60_000])("期限切れと長すぎる検証窓は送らない", async (remaining) => {
    const send = vi.fn<typeof fetch>();
    const response = await createProbe(send).request("https://probe.test/probe", request(), {
      ...config(),
      PROBE_EXPIRES_AT: new Date(Date.now() + remaining).toISOString(),
    });
    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "{}",
    "{",
    JSON.stringify({ device_token: "bad-token" }),
    JSON.stringify({ device_token: token, topic: "another-app" }),
  ])("不正な本文と任意の送り先は受けない", async (body) => {
    const send = vi.fn<typeof fetch>();
    const response = await createProbe(send).request(
      "https://probe.test/probe",
      request(body),
      config(),
    );
    expect([400, 422]).toContain(response.status);
    expect(send).not.toHaveBeenCalled();
  });

  it("本文の上限を超えたら送らない", async () => {
    const send = vi.fn<typeof fetch>();
    const response = await createProbe(send).request(
      "https://probe.test/probe",
      request(" ".repeat(513)),
      config(),
    );
    expect(response.status).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it("リダイレクトや未知のAPNsエラーに秘密を写さず、送り直さない", async () => {
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ reason: `private-${token}` }), {
          status: 302,
          headers: { location: "https://another.test", "apns-id": `private-${token}` },
        }),
    );
    const response = await createProbe(send).request(
      "https://probe.test/probe",
      request(),
      config(),
    );
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("private-");
    expect(JSON.parse(text)).toMatchObject({
      kind: "apns_response",
      status: 302,
      reason: "other",
      apns_id: null,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("fetch例外にトークンやJWTが含まれても応答に出さない", async () => {
    const send = vi.fn<typeof fetch>(async () => {
      throw new Error(`${token}:test.provider.token`);
    });
    const response = await createProbe(send).request(
      "https://probe.test/probe",
      request(),
      config(),
    );
    const text = await response.text();
    expect(text).not.toContain(token);
    expect(text).not.toContain("test.provider.token");
    expect(JSON.parse(text)).toMatchObject({ kind: "transport_error" });
    expect(send).toHaveBeenCalledOnce();
  });
});
