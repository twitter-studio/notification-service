import { z } from "zod";

const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const HttpCounts = z.strictObject({
  total: count,
  unauthorized: count,
  forbidden: count,
  throttled: count,
  failed: count,
});
const ApnsCounts = z.strictObject({
  total: count,
  auth_failed: count,
  throttled: count,
  failed: count,
  exhausted: count,
});
const Snapshot = z
  .strictObject({
    window_seconds: z.literal(300),
    http: HttpCounts,
    apns: ApnsCounts,
    queue: z.strictObject({ backlog: count, oldest_age_seconds: count }),
  })
  .superRefine((value, ctx) => {
    if (
      value.http.unauthorized + value.http.forbidden + value.http.throttled + value.http.failed >
        value.http.total ||
      value.apns.auth_failed + value.apns.throttled + value.apns.failed > value.apns.total
    )
      ctx.addIssue({ code: "custom", message: "invalid aggregate" });
  });

/** 5分の完全な集計だけを評価する。未取得のメトリクスを0として扱わない (ADR-0013)。 */
export function evaluateMonitoring(input: unknown) {
  const parsed = Snapshot.safeParse(input);
  if (!parsed.success) return { status: "invalid" } as const;
  const { http, apns, queue } = parsed.data;
  const alerts: string[] = [];
  if (apns.auth_failed > 0) alerts.push("apns_auth_failed");
  if (apns.exhausted > 0) alerts.push("apns_delivery_exhausted");
  if (http.failed >= 5 && http.failed / http.total >= 0.05) alerts.push("http_failure_rate");
  if (
    http.unauthorized + http.forbidden >= 20 &&
    (http.unauthorized + http.forbidden) / http.total >= 0.1
  )
    alerts.push("http_auth_rate");
  if (http.throttled >= 10 && http.throttled / http.total >= 0.2)
    alerts.push("http_throttled_rate");
  if (apns.failed >= 5 && apns.failed / apns.total >= 0.05) alerts.push("apns_failure_rate");
  if (apns.throttled >= 5 && apns.throttled / apns.total >= 0.1) alerts.push("apns_throttled_rate");
  if (queue.backlog > 0 && queue.oldest_age_seconds >= 3300) alerts.push("queue_stalled");
  return { status: alerts.length > 0 ? "alert" : "ok", alerts } as const;
}
