import { recordTelemetry } from "./telemetry";

export async function recordQueueMetrics(queue: Pick<Queue, "metrics">, now: number) {
  try {
    const metrics = await queue.metrics();
    if (!Number.isSafeInteger(metrics.backlogCount) || metrics.backlogCount < 0) throw new Error();
    const oldest = metrics.oldestMessageTimestamp?.getTime();
    if (
      metrics.backlogCount > 0 &&
      (oldest === undefined || !Number.isFinite(oldest) || oldest <= 0)
    )
      throw new Error();
    recordTelemetry({
      event: "queue_state",
      backlog_count: metrics.backlogCount,
      oldest_age_seconds:
        metrics.backlogCount === 0 || oldest === undefined
          ? 0
          : Math.max(0, Math.floor((now - oldest) / 1000)),
    });
  } catch {
    // 取得失敗を空のQueueとせず、例外の値を含めない別の警報にする。
    console.error(JSON.stringify({ event: "queue_metrics_unavailable" }));
  }
}
