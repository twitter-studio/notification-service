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
  console.info(data);
}
