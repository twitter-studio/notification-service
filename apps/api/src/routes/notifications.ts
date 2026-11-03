import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  beginEvent,
  completeEvent,
  consumeDailyRelayQuota,
  createDb,
  findEventState,
  invalidateDevice,
  listActiveDevices,
  releaseEvent,
  utcDayStart,
} from "@notification-service/db";
import { createMiddleware } from "hono/factory";
import type { AppEnv, RelayEnv } from "../app";
import { ACCEPTED_EVENT_RETENTION_MS, CLEANUP_INTERVAL_MS } from "../maintenance";
import { requireRelayCredential } from "../middleware/relay";
import {
  EVENT_TYPES,
  EVENT_TYPES_WITHOUT_POST,
  eventKeyOf,
  notificationPayload,
} from "../notifications/payload";
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

/**
 * 1 つのアカウントが 1 日に受け付けられるイベントの数。D1 の書き込み (無料のプランで 1 日 10 万行) を、1 つのアカウントで
 * 使い切らせない。受け付けの記録は数として残るので、DB で数える (ADR-0009)。
 */
export const MAX_EVENTS_PER_DAY = 1000;

/** 端末へ送る時間の上限。受け付けの記録のリース (2 分) より短くし、引き継がれる前に送り終える。 */
export const SEND_BUDGET_MS = 60 * 1000;

const IN_PROGRESS_RETRY_AFTER_SECONDS = 30;
const UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

const EventSchema = z
  .strictObject({
    event_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    type: z.enum(EVENT_TYPES),
    // X の ID (64 ビットの整数) は 19 桁まで (19 桁でも int64 を越える値は、アプリで確かめる)。
    post_id: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .optional()
      .openapi({ description: "ツイートの ID。follow 以外では要り、follow では送らない" }),
    // UTC (末尾が Z) だけを受ける。
    occurred_at: z.iso.datetime(),
  })
  .openapi("RelayEvent");

/** 資格情報を確かめた後、本文を確かめる前に数える (形の違う本文も数える)。 */
const relayRateLimit = createMiddleware<RelayEnv>(async (c, next) => {
  await enforceRateLimit(c.env.RELAY_RATE_LIMITER, `relay:${c.get("relayCredential").accountId}`);
  await next();
});

const route = createRoute({
  method: "post",
  path: "/v1/notifications",
  middleware: [requireRelayCredential, relayRateLimit] as const,
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

function inProgress(): ProblemError {
  return new ProblemError(409, "Conflict", "The event is being processed.", {
    "Retry-After": String(IN_PROGRESS_RETRY_AFTER_SECONDS),
  });
}

function unavailable(): ProblemError {
  return new ProblemError(503, "Service Unavailable", undefined, {
    "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export function registerNotifications(
  app: OpenAPIHono<AppEnv>,
  push: PushGateway,
  sendBudgetMs: number,
) {
  app.openapi(route, async (c) => {
    const credential = c.get("relayCredential");
    const body = c.req.valid("json");
    if (EVENT_TYPES_WITHOUT_POST.has(body.type) === (body.post_id !== undefined))
      throw new ProblemError(422, "Unprocessable Content", "The post ID does not match the type.");
    const now = new Date();
    const occurredAt = Date.parse(body.occurred_at);
    if (
      occurredAt > now.getTime() + EVENT_CLOCK_SKEW_MS ||
      occurredAt < now.getTime() - MAX_EVENT_AGE_MS
    )
      throw new ProblemError(422, "Unprocessable Content", "The event time is out of range.");

    const db = createDb(c.env.DB);
    const logFailure = (event: string, error: unknown) =>
      console.error(
        JSON.stringify({
          event,
          request_id: c.get("requestId"),
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
    const accepted = { event_id: body.event_id, status: "accepted" as const };

    let devices: Awaited<ReturnType<typeof listActiveDevices>>;
    let keys: Awaited<ReturnType<typeof loadDeviceTokenKeys>>;
    let event: { accountId: string; eventKey: string };
    let start: Awaited<ReturnType<typeof beginEvent>>;
    try {
      devices = await listActiveDevices(db, credential.accountId);
      // 送り先がなければ、記録を書かずに受け付ける (D1 の書き込みを使わない)。
      if (devices.length === 0) return c.json(accepted, 202);
      keys = await loadDeviceTokenKeys(c.env);
      event = {
        accountId: credential.accountId,
        eventKey: await eventKeyOf(keys, credential.accountId, body.event_id),
      };
      // 済んだ重複と処理中のやり直しは、1 日の上限より先に答える (上限に届いた後も、やり直しの答えを変えない)。
      const state = await findEventState(db, event, now);
      if (state === "done")
        return c.json({ event_id: body.event_id, status: "duplicate" as const }, 202);
      if (state === "in_progress") throw inProgress();
      // 新しいイベントのときだけ、1 日の数を 1 行で数える。止まった処理中の記録は、最初に受け付けたときに数えている。
      if (
        state === "new" &&
        !(await consumeDailyRelayQuota(
          db,
          { accountId: credential.accountId, limit: MAX_EVENTS_PER_DAY },
          now,
        ))
      ) {
        // 次の UTC の 0 時 (数え直す時刻) まで待ってもらう。
        const retryAfter = Math.ceil(
          (utcDayStart(now).getTime() + 24 * 60 * 60 * 1000 - now.getTime()) / 1000,
        );
        throw new ProblemError(429, "Too Many Requests", undefined, {
          "Retry-After": String(retryAfter),
        });
      }
      // 受け付けの記録には、サーバーの時刻を渡す (送り手の時刻で、記録を早く消させない)。
      start = await beginEvent(db, event, now);
    } catch (error) {
      if (error instanceof ProblemError) throw error;
      logFailure("relay_accept_failed", error);
      throw unavailable();
    }
    // 読んだ後に、ほかの要求が先に受け付けた。
    if (start.kind === "done")
      return c.json({ event_id: body.event_id, status: "duplicate" as const }, 202);
    if (start.kind === "in_progress") throw inProgress();
    const lease = { ...event, leaseId: start.leaseId };

    const outcomes: Partial<Record<PushOutcome | "unreadable" | "skipped", number>> = {};
    const count = (outcome: PushOutcome | "unreadable" | "skipped") => {
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    };
    const deadline = Date.now() + sendBudgetMs;
    try {
      const notification = {
        eventKey: event.eventKey,
        payload: notificationPayload({
          eventId: body.event_id,
          type: body.type,
          postId: body.post_id,
        }),
      };
      for (const device of devices) {
        const remaining = deadline - Date.now();
        // 時間の上限を過ぎたら、残りの端末には送らない (リースが切れて、引き継いだ要求と 2 回送らないため)。
        if (remaining <= 0) {
          count("skipped");
          continue;
        }
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
          { signal: AbortSignal.timeout(remaining) },
        );
        count(outcome);
        if (outcome === "invalid_token")
          await invalidateDevice(db, {
            deviceId: device.id,
            tokenFingerprint: device.tokenFingerprint,
          });
      }
    } catch (error) {
      // 送る途中で失敗した (D1、鍵の設定など)。受け付けの記録を消し、送り手のやり直しを受け付ける。
      // 途中まで送っていたら、やり直しで同じ通知が 2 回届きうる (配信は少なくとも 1 回。ADR-0001 §5)。
      await releaseEvent(db, lease).catch(() => {});
      logFailure("relay_delivery_failed", error);
      throw unavailable();
    }

    // 送った後に記録を済みにできなくても、送ったので 202 を返す (503 にすると、やり直しでもう 1 回送る)。
    // 記録は処理中のまま残り、リースが切れた後のやり直しで、もう 1 回送りうる。
    try {
      // 済みにできなかった (false) のは、時間がかかってリースが切れ、ほかの要求が引き継いだとき。その要求も送るので、2 回届く。
      if (!(await completeEvent(db, lease))) logFailure("relay_lease_lost", undefined);
    } catch (error) {
      logFailure("relay_complete_failed", error);
    }
    const incomplete = (["unreadable", "failed", "retry_later", "skipped"] as const).some(
      (outcome) => (outcomes[outcome] ?? 0) > 0,
    );
    // 送れなかった端末があれば、運営が気づけるよう error で出す (鍵の入れ替えの誤り、APNs の止まりなど)。
    // 今は端末ごとにやり直さないので、その通知は届かない (APNS-002 でやり直しを決める)。
    (incomplete ? console.error : console.log)(
      JSON.stringify({ event: "relay_delivered", request_id: c.get("requestId"), outcomes }),
    );
    return c.json(accepted, 202);
  });
}
