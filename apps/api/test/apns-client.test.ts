import { describe, expect, it, vi } from "vitest";
import { ApnsClient, type ApnsRequest } from "../src/apns/client";
import { fromBase64Url } from "../src/security/encoding";

import { signingConfiguration } from "./helpers/apns";

function request(): ApnsRequest {
  return {
    target: {
      apnsToken: "ab".repeat(32),
      apnsEnvironment: "sandbox",
      topic: "com.twitter-studio.Tweetbot",
    },
    payload: { aps: { alert: "test" } },
    pushType: "alert",
    id: crypto.randomUUID(),
    expiresAt: Date.now() + 3600_000,
    collapseId: "a".repeat(43),
    signal: new AbortController().signal,
  };
}

describe("APNs の直接送信", () => {
  it("P-256 の実署名を検証できる ES256 JWT と固定 endpoint の要求を送る", async () => {
    const config = await signingConfiguration();
    const received: { url: string; init: RequestInit | undefined }[] = [];
    const now = Date.now();
    const client = new ApnsClient(config.json, {
      now: () => now,
      send: async (url, init) => {
        received.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      },
    });
    const input = request();
    expect(await client.deliver(input)).toEqual({ kind: "sent" });
    expect(received[0]?.url).toBe(
      `https://api.sandbox.push.apple.com/3/device/${input.target.apnsToken}`,
    );
    const headers = new Headers(received[0]?.init?.headers);
    expect(headers.get("apns-topic")).toBe(input.target.topic);
    expect(headers.get("apns-push-type")).toBe("alert");
    expect(headers.get("apns-priority")).toBe("10");
    expect(headers.get("apns-id")).toBe(input.id);
    expect(headers.get("apns-collapse-id")).toBe(input.collapseId);
    expect(received[0]?.init?.redirect).toBe("manual");
    const token = headers.get("authorization")?.slice(7) ?? "";
    const [header, claims, signature] = token.split(".");
    if (header === undefined || claims === undefined || signature === undefined)
      throw new Error("JWT missing");
    const decode = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(s)));
    expect(decode(header)).toEqual({ alg: "ES256", kid: "TESTKEY001" });
    expect(decode(claims)).toEqual({ iss: "TESTTEAM01", iat: Math.floor(now / 1000) });
    const bytes = fromBase64Url(signature);
    if (bytes === undefined) throw new Error("signature missing");
    expect(bytes.length).toBe(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        config.publicKey,
        bytes,
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
  });

  it("並行要求と50分未満の再送は同じ JWT を使い、50分後に更新する", async () => {
    const config = await signingConfiguration();
    let now = Date.now();
    const tokens: (string | null)[] = [];
    const client = new ApnsClient(config.json, {
      now: () => now,
      send: async (_url, init) => {
        tokens.push(new Headers(init?.headers).get("authorization"));
        return new Response();
      },
    });
    await Promise.all([client.deliver(request()), client.deliver(request())]);
    now += 49 * 60_000;
    await client.deliver(request());
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[0]).toBe(tokens[2]);
    now += 60_000;
    await client.deliver(request());
    expect(tokens[3]).not.toBe(tokens[0]);
  });

  it.each([
    [400, "BadDeviceToken", "invalid_token"],
    [410, "Unregistered", "invalid_token"],
    [410, "unknown", "failed"],
    [400, "DeviceTokenNotForTopic", "failed"],
    [403, "ExpiredProviderToken", "failed"],
    [302, "anything", "failed"],
    [429, "TooManyRequests", "retry"],
    [500, "InternalServerError", "retry"],
    [503, "Shutdown", "retry"],
  ])("status %i / %s を %s とし、その場で再送しない", async (status, reason, kind) => {
    const config = await signingConfiguration();
    const send = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ reason, timestamp: Date.now() }), { status }),
    );
    const result = await new ApnsClient(config.json, { send }).deliver(request());
    expect(result.kind).toBe(kind);
    if (result.kind === "retry") expect(result.delaySeconds).toBe(status >= 500 ? 900 : 60);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sandbox 専用の鍵を production や違う topic へ送らない", async () => {
    const config = await signingConfiguration();
    const send = vi.fn<typeof fetch>();
    const client = new ApnsClient(config.json, { send });
    const input = request();
    input.target.apnsEnvironment = "production";
    expect(await client.deliver(input)).toEqual({ kind: "not_configured" });
    input.target.apnsEnvironment = "sandbox";
    input.target.topic = "other.topic";
    expect(await client.deliver(input)).toEqual({ kind: "not_configured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("background push の priority は5にする", async () => {
    const config = await signingConfiguration();
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("apns-priority")).toBe("5");
      return new Response();
    });
    const input = request();
    input.pushType = "background";
    expect((await new ApnsClient(config.json, { send }).deliver(input)).kind).toBe("sent");
  });

  it("中止済みの要求を送らず、秘密を含む fetch の例外を外へ出さない", async () => {
    const config = await signingConfiguration();
    const send = vi.fn<typeof fetch>(async () => {
      throw new Error("private-url-and-token");
    });
    const client = new ApnsClient(config.json, { send });
    const input = request();
    input.signal = AbortSignal.abort();
    expect((await client.deliver(input)).kind).toBe("retry");
    expect(send).not.toHaveBeenCalled();
    expect(await client.deliver(request())).toEqual({ kind: "retry", delaySeconds: 60 });
  });

  it("壊れた設定のエラーに入力を含めず、壊れた署名鍵で送らない", async () => {
    expect(await new ApnsClient("private-input").deliver(request())).toEqual({ kind: "failed" });
    const config = await signingConfiguration();
    const send = vi.fn<typeof fetch>();
    const client = new ApnsClient(
      JSON.stringify([{ ...config.configuration, private_key: "private-input" }]),
      { send },
    );
    expect(await client.deliver(request())).toEqual({ kind: "failed" });
    expect(send).not.toHaveBeenCalled();
    expect(
      await new ApnsClient(JSON.stringify([config.configuration, config.configuration])).deliver(
        request(),
      ),
    ).toEqual({ kind: "failed" });
  });

  it("大きすぎる APNs の本文で端末を無効にせず、reader を閉じる", async () => {
    const config = await signingConfiguration();
    const cancel = vi.fn();
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(2048));
            },
            cancel,
          }),
          { status: 400 },
        ),
    );
    expect((await new ApnsClient(config.json, { send }).deliver(request())).kind).toBe("failed");
    expect(cancel).toHaveBeenCalled();
  });
});
