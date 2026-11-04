import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { recordTelemetry } from "../src/telemetry";

const CANARY = "private-canary-do-not-log";

afterEach(() => vi.restoreAllMocks());

describe("秘密を含めない監視", () => {
  it.each([200, 401, 403, 429, 503])(
    "HTTP %s をサーバーの request ID で1回だけ数える",
    async (status) => {
      const logs = vi.spyOn(console, "info").mockImplementation(() => {});
      const app = createApp();
      app.all("/test/:id", () => new Response("ok", { status }));
      const response = await app.request(
        `https://notification.test/test/${CANARY}?secret=${CANARY}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CANARY}`,
            "X-Request-Id": CANARY,
            "X-Private": CANARY,
          },
          body: CANARY,
        },
      );
      expect(response.status).toBe(status);
      expect(logs.mock.calls).toEqual([
        [
          {
            event: "http_request",
            request_id: response.headers.get("X-Request-Id"),
            status,
          },
        ],
      ]);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(CANARY);
    },
  );

  it("型を通らない呼び出しでも、未宣言の値や不正なログを記録しない", () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    Reflect.apply(recordTelemetry, undefined, [
      {
        event: "apns_response",
        status: 403,
        push_type: "alert",
        token: CANARY,
        body: CANARY,
      },
    ]);
    Reflect.apply(recordTelemetry, undefined, [
      { event: "http_request", request_id: CANARY, status: 500 },
    ]);
    expect(logs.mock.calls).toEqual([
      [{ event: "apns_response", status: 403, push_type: "alert" }],
    ]);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(CANARY);
  });

  it("例外の name・message・cause に入った値を500の応答にもログにも残さない", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = createApp();
    app.get("/failure", () => {
      const error = new Error(CANARY, { cause: { secret: CANARY } });
      error.name = CANARY;
      throw error;
    });
    const response = await app.request("https://notification.test/failure");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(CANARY);
    expect(JSON.stringify([...errors.mock.calls, ...logs.mock.calls])).not.toContain(CANARY);
    expect(logs.mock.calls).toContainEqual([
      { event: "http_request", request_id: response.headers.get("X-Request-Id"), status: 500 },
    ]);
  });
});
