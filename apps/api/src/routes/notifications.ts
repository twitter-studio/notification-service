import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  beginEvent,
  completeEvent,
  createDb,
  invalidateDevice,
  listActiveDevices,
  releaseEvent,
} from "@notification-service/db";
import type { AppEnv } from "../app";
import { ACCEPTED_EVENT_RETENTION_MS, CLEANUP_INTERVAL_MS } from "../maintenance";
import { requireRelayCredential } from "../middleware/relay";
import { EVENT_TYPES, notificationPayload } from "../notifications/payload";
import type { PushGateway, PushOutcome } from "../notifications/push";
import { ProblemError } from "../problem";
import { loadDeviceTokenKeys, openDeviceToken } from "../security/device-token";
import { enforceRateLimit } from "../security/rate-limit";
import { commonProblems, problemResponse } from "./openapi";

// 利用者の Worker からイベントを受け付け、そのアカウントの端末へ送る (設計書 §4、API-003、ADR-0009)。
// 送り先のアカウントは、中継の資格情報だけで決める。本文で、アカウント、X の ID、トークン、文、URL を受けない。

/** 送り手とサーバーの時計のずれとして許す幅。 */
export const EVENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * 受け付けるイベントの古さの上限。受け付けの記録 (重複の除去) が消えた後のやり直し (リプレイ) を受けないよう、記録を残す期間から、
 * 掃除の間隔と時計のずれを引く。
 */
export const MAX_EVENT_AGE_MS =
  ACCEPTED_EVENT_RETENTION_MS - CLEANUP_INTERVAL_MS - EVENT_CLOCK_SKEW_MS;

/** 処理中のやり直しに待ってもらう秒数。 */
const IN_PROGRESS_RETRY_AFTER_SECONDS = 30;

/** 送れなかったときに待ってもらう秒数。 */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

const EventSchema = z
  .strictObject({
    event_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    type: z.enum(EVENT_TYPES),
    post_id: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .optional(),
    // UTC (末尾が Z) だけを受ける。
    occurred_at: z.iso.datetime(),
  })
  .openapi("RelayEvent");

const route = createRoute({
  method: "post",
  path: "/v1/notifications",
  middleware: [requireRelayCredential] as const,
  summary: "利用者の Worker からイベントを受け付け、中継の資格情報のアカウントの端末へ送る",
  request: {
    body: { required: true, content: { "application/json": { schema: EventSchema } } },
  },
  responses: {
    202: {
      description:
        "受け付けた (端末に出た証明ではない)。`duplicate` は、同じイベントをもう受け付けていた (送り手のやり直し)",
      content: {
        "application/json": {
          schema: z
            .object({ event_id: z.string(), status: z.enum(["accepted", "duplicate"]) })
            .openapi("RelayAccepted"),
        },
      },
    },
    401: problemResponse("中継の資格情報がない、または使えない (やり直さない)"),
    409: problemResponse("同じイベントを送っている途中 (Retry-After の秒数を待ってやり直す)"),
    503: problemResponse("送れなかった (Retry-After の秒数を待ってやり直す)"),
    ...commonProblems,
  },
});

export function registerNotifications(app: OpenAPIHono<AppEnv>, push: PushGateway) {
  app.openapi(route, async (c) => {
    const credential = c.get("relayCredential");
    await enforceRateLimit(c.env.RELAY_RATE_LIMITER, `relay:${credential.accountId}`);
    const body = c.req.valid("json");
    const now = new Date();
    const occurredAt = Date.parse(body.occurred_at);
    if (
      occurredAt > now.getTime() + EVENT_CLOCK_SKEW_MS ||
      occurredAt < now.getTime() - MAX_EVENT_AGE_MS
    )
      throw new ProblemError(422, "Unprocessable Content", "The event time is out of range.");

    const db = createDb(c.env.DB);
    const event = { accountId: credential.accountId, eventId: body.event_id };
    // 受け付けの記録には、サーバーの時刻を渡す (送り手の時刻で、記録を早く消させない)。
    const start = await beginEvent(db, event, now);
    if (start.kind === "done")
      return c.json({ event_id: body.event_id, status: "duplicate" as const }, 202);
    if (start.kind === "in_progress") {
      throw new ProblemError(409, "Conflict", "The event is being processed.", {
        "Retry-After": String(IN_PROGRESS_RETRY_AFTER_SECONDS),
      });
    }

    const outcomes: Partial<Record<PushOutcome | "unreadable", number>> = {};
    const count = (outcome: PushOutcome | "unreadable") => {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    };
    try {
      const devices = await listActiveDevices(db, credential.accountId);
      const keys = devices.length > 0 ? await loadDeviceTokenKeys(c.env) : undefined;
      const notification = {
        eventId: body.event_id,
        payload: notificationPayload({
          eventId: body.event_id,
          type: body.type,
          postId: body.post_id,
        }),
      };
      for (const device of devices) {
        if (keys === undefined) break;
        let apnsToken: string;
        try {
          apnsToken = await openDeviceToken(keys, {
            ciphertext: device.apnsTokenCiphertext,
            fingerprint: device.tokenFingerprint,
            installationId: device.installationId,
            apnsEnvironment: device.apnsEnvironment,
            topic: device.topic,
          });
        } catch {
          // 読めない暗号文 (鍵を消した、書き換えられた) は送らない。ほかの端末には送る。
          count("unreadable");
          continue;
        }
        const outcome = await push(
          {
            deviceId: device.id,
            apnsToken,
            apnsEnvironment: device.apnsEnvironment,
            topic: device.topic,
          },
          notification,
        );
        count(outcome);
        if (outcome === "invalid_token")
          await invalidateDevice(db, {
            deviceId: device.id,
            tokenFingerprint: device.tokenFingerprint,
          });
      }
    } catch (error) {
      // 送る前のどこかで失敗した (D1、鍵の設定など)。受け付けの記録を消し、送り手のやり直しを受け付ける。
      // 途中まで送っていたら、やり直しで同じ通知が 2 回届きうる (配信は少なくとも 1 回。ADR-0001 §5)。
      await releaseEvent(db, event).catch(() => {});
      console.error(
        JSON.stringify({
          event: "relay_delivery_failed",
          request_id: c.get("requestId"),
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
      throw new ProblemError(503, "Service Unavailable", undefined, {
        "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
      });
    }
    await completeEvent(db, event);
    console.log(
      JSON.stringify({ event: "relay_delivered", request_id: c.get("requestId"), outcomes }),
    );
    return c.json({ event_id: body.event_id, status: "accepted" as const }, 202);
  });
}
