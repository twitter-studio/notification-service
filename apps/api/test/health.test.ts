import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("動いていることだけを、200 で返す", async () => {
    const response = await exports.default.fetch("https://notification.test/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("ない path には 404 を返す", async () => {
    const response = await exports.default.fetch("https://notification.test/unknown");

    expect(response.status).toBe(404);
  });
});
