import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { recordQueueMetrics } from "../src/queue-metrics";

afterEach(() => vi.restoreAllMocks());

describe("Queueの定期監視", () => {
  it.each([0, 3300])("最古の待機秒数%sを識別子なしで記録する", async (age) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await recordQueueMetrics(
      {
        metrics: async () => ({
          backlogCount: age === 0 ? 0 : 1,
          backlogBytes: age === 0 ? 0 : 100,
          ...(age === 0 ? {} : { oldestMessageTimestamp: new Date(1000) }),
        }),
      },
      1000 + age * 1000,
    );
    expect(info.mock.calls).toEqual([
      [
        {
          event: "queue_state",
          backlog_count: age === 0 ? 0 : 1,
          backlog_bytes: age === 0 ? 0 : 100,
          backlog_present: age === 0 ? 0 : 1,
          oldest_age_seconds: age,
        },
      ],
    ]);
  });
  it("件数0でもbytesと最古時刻が残ればageを保持する", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await recordQueueMetrics(
      {
        metrics: async () => ({
          backlogCount: 0,
          backlogBytes: 559,
          oldestMessageTimestamp: new Date(1000),
        }),
      },
      3301000,
    );
    expect(info.mock.calls).toEqual([
      [
        {
          event: "queue_state",
          backlog_count: 0,
          backlog_bytes: 559,
          backlog_present: 1,
          oldest_age_seconds: 3300,
        },
      ],
    ]);
  });
  it.each(["error", "unknown_oldest", "bytes_unknown_oldest", "invalid_bytes"])(
    "%sを正常な空のQueueとせず、秘密も記録しない",
    async (kind) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await recordQueueMetrics(
        {
          metrics: async () => {
            if (kind === "error") throw new Error("private-canary");
            return {
              backlogCount: kind === "bytes_unknown_oldest" ? 0 : 1,
              backlogBytes: kind === "invalid_bytes" ? -1 : 100,
            };
          },
        },
        1000,
      );
      expect(info).not.toHaveBeenCalled();
      expect(error.mock.calls).toEqual([[JSON.stringify({ event: "queue_metrics_unavailable" })]]);
    },
  );
});

it("5分のCronはQueue監視を実行し、空の状態を記録する", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const metrics = vi.fn(async () => ({ backlogCount: 0, backlogBytes: 0 }));
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ cron: "*/5 * * * *", scheduledTime: Date.now() }),
    {
      ...env,
      APNS_RETRIES: {
        metrics,
        send: env.APNS_RETRIES.send.bind(env.APNS_RETRIES),
        sendBatch: env.APNS_RETRIES.sendBatch.bind(env.APNS_RETRIES),
      },
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(metrics).toHaveBeenCalledTimes(1);
  expect(info.mock.calls).toEqual([
    [
      {
        event: "queue_state",
        backlog_count: 0,
        backlog_bytes: 0,
        backlog_present: 0,
        oldest_age_seconds: 0,
      },
    ],
  ]);
});
