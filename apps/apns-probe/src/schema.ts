import { z } from "@hono/zod-openapi";

export const configuration = z.object({
  APNS_PROVIDER_TOKEN: z
    .string()
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  PROBE_AUTH_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  PROBE_EXPIRES_AT: z.iso.datetime(),
});
export const reasons = z.enum([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "InvalidProviderToken",
  "ExpiredProviderToken",
  "TopicDisallowed",
  "Unregistered",
  "TooManyRequests",
  "TooManyProviderTokenUpdates",
  "other",
]);
const measurement = {
  request_id: z.uuid(),
  elapsed_ms: z.number().nonnegative(),
  // fetch の Response から HTTP の版と CPU 時間は取り出せない。測れた値と混ぜない。
  http_protocol: z.literal("not_exposed"),
  cpu_ms: z.null(),
};
export const evidence = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("apns_response"),
    ...measurement,
    status: z.number().int(),
    apns_id: z.uuid().nullable(),
    reason: reasons.nullable(),
  }),
  z.object({ kind: z.literal("transport_error"), ...measurement }),
]);
