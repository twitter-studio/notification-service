import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("APNs 設定と API の可用性", () => {
  it("APNs secret が存在しなくても health は使える", async () => {
    const missing = { ...env };
    Reflect.deleteProperty(missing, "APNS_PROVIDER_KEYS");
    const response = await worker.fetch(
      new Request("https://notification.test/health"),
      missing,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
  });
  it("APNs 設定が壊れても health と認証エラーの応答を止めない", async () => {
    const invalid = { ...env, APNS_PROVIDER_KEYS: "invalid-private-input" };
    const health = await worker.fetch(
      new Request("https://notification.test/health"),
      invalid,
      createExecutionContext(),
    );
    expect(health.status).toBe(200);
    const request = new Request<unknown, IncomingRequestCfProperties>(
      "https://notification.test/v1/relay-credentials/00000000-0000-4000-8000-000000000000",
      { method: "DELETE" },
    );
    const response = await worker.fetch(request, invalid, createExecutionContext());
    expect(response.status).toBe(401);
  });
});
