import { z } from "zod";

const Telemetry = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("http_request"),
    request_id: z.uuid(),
    status: z.int().min(100).max(599),
  }),
  z.object({
    event: z.literal("notification_accepted"),
    request_id: z.uuid(),
    outcome: z.enum(["accepted", "duplicate"]),
  }),
  z.object({
    event: z.literal("apns_response"),
    status: z.int().min(100).max(599),
    push_type: z.enum(["alert", "background"]),
  }),
  z.object({
    event: z.literal("delivery_retry"),
    stage: z.enum(["queued", "requeued"]),
    attempt: z.int().min(1).max(2),
    delay_seconds: z.int().min(60).max(1980),
  }),
  z.object({
    event: z.literal("queue_state"),
    backlog_count: z.int().nonnegative(),
    oldest_age_seconds: z.int().nonnegative(),
  }),
  z.object({
    event: z.literal("delivery_discarded"),
    reason: z.enum(["attempt_limit", "invalid_job", "expired", "unauthorized", "inactive_device"]),
  }),
]);

/** 外からの値をログへ広げない。未宣言のフィールドを落とし、不正なログは配信を止めず捨てる (ADR-0013)。 */
export function recordTelemetry(event: z.input<typeof Telemetry>): void {
  const parsed = Telemetry.safeParse(event);
  if (!parsed.success) return;
  const data = parsed.data;
  // オブジェクトで渡し、Workers Logs の集計で event / status を直接選べるようにする。
  if (data.event === "http_request" || data.event === "apns_response") {
    // JSON属性の条件付き集計をSQL APIが拒むため、statusから決まる数だけを記録する (#35)。
    console.info({
      ...data,
      server_error_count: Number(data.status >= 500),
      auth_error_count: Number(
        data.status === 403 || (data.event === "http_request" && data.status === 401),
      ),
      throttled_count: Number(data.status === 429),
    });
  } else console.info(data);
}
