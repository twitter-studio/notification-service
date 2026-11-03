import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("エラーの応答", () => {
  it("ない path には、404 の problem+json と、サーバーが作った request_id を返す", async () => {
    const response = await exports.default.fetch("https://notification.test/unknown", {
      headers: { "X-Request-Id": "chosen-by-sender" },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ type: "about:blank", title: "Not Found", status: 404 });
    expect(body.request_id).toMatch(UUID);
    expect(response.headers.get("X-Request-Id")).toBe(body.request_id);
  });

  it("JSON として読めない本文は 400、application/json でない本文は 415 の problem+json にする", async () => {
    for (const [headers, body, status] of [
      [{ "Content-Type": "application/json" }, "{", 400],
      [{ "Content-Type": "text/plain" }, JSON.stringify({ purpose: "enroll" }), 415],
    ] as const) {
      const response = await exports.default.fetch(
        "https://notification.test/v1/enrollments/challenge",
        { method: "POST", headers, body },
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");
      expect(await response.json()).toMatchObject({ status });
    }
  });

  it("/v1 の応答は、途中の cache に残させない", async () => {
    const response = await exports.default.fetch("https://notification.test/v1/unknown");

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("思わぬエラーは 500 の problem+json にし、エラーの文を応答にもログにも出さない", async () => {
    const app = createApp();
    app.get("/boom", () => {
      throw new Error("token=secret-value");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.request("https://notification.test/boom");
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    expect(JSON.parse(text)).toMatchObject({ title: "Internal Server Error", status: 500 });
    expect(text).not.toContain("secret-value");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-value");
    log.mockRestore();
  });
});
