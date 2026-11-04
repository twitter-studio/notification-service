import { describe, expect, it } from "vitest";
import { evaluateMonitoring } from "../src/monitoring";

function snapshot() {
  return {
    window_seconds: 300,
    http: { total: 100, unauthorized: 0, forbidden: 0, throttled: 0, failed: 0 },
    apns: { total: 100, auth_failed: 0, throttled: 0, failed: 0, exhausted: 0 },
    queue: { backlog: 0, backlog_bytes: 0, oldest_age_seconds: 0 },
  };
}

describe("5分の通知監視の判定", () => {
  it("静かな正常な窓では警報を出さない", () => {
    const value = snapshot();
    value.http.total = 0;
    value.apns.total = 0;
    expect(evaluateMonitoring(value)).toEqual({ status: "ok", alerts: [] });
  });
  it.each(["auth_failed", "exhausted"] as const)("APNs の %s は1件で警報にする", (field) => {
    const value = snapshot();
    value.apns[field] = 1;
    expect(evaluateMonitoring(value).status).toBe("alert");
  });
  it("HTTP の認証・制限・5xxの件数と割合をそれぞれ検査する", () => {
    const value = snapshot();
    value.http.unauthorized = 20;
    value.http.throttled = 20;
    value.http.failed = 5;
    expect(evaluateMonitoring(value)).toEqual({
      status: "alert",
      alerts: ["http_failure_rate", "http_auth_rate", "http_throttled_rate"],
    });
    value.http.total = 1000;
    expect(evaluateMonitoring(value)).toEqual({ status: "ok", alerts: [] });
  });
  it("APNs の429・5xx と、通常の遅延を超えた Queue の停滞を検出する", () => {
    const value = snapshot();
    value.apns.throttled = 10;
    value.apns.failed = 5;
    value.queue = { backlog: 1, backlog_bytes: 100, oldest_age_seconds: 3300 };
    expect(evaluateMonitoring(value)).toEqual({
      status: "alert",
      alerts: ["apns_failure_rate", "apns_throttled_rate", "queue_stalled"],
    });
    value.queue.oldest_age_seconds = 3299;
    expect(evaluateMonitoring(value)).not.toMatchObject({
      alerts: expect.arrayContaining(["queue_stalled"]),
    });
  });
  it("件数0でもbytesが残り3300秒なら停滞を検出する", () => {
    const value = snapshot();
    value.queue = { backlog: 0, backlog_bytes: 559, oldest_age_seconds: 3300 };
    expect(evaluateMonitoring(value)).toEqual({ status: "alert", alerts: ["queue_stalled"] });
  });
  it.each([
    {},
    { ...snapshot(), window_seconds: 60 },
    { ...snapshot(), token: "canary" },
    { ...snapshot(), http: { ...snapshot().http, failed: 101 } },
  ])("未取得・不正・余分な項目のある集計を正常と判定しない", (value) => {
    expect(evaluateMonitoring(value)).toEqual({ status: "invalid" });
  });
});
