import { OpenAPIHono } from "@hono/zod-openapi";
import type { ActiveRelayCredential, ActiveSession } from "@notification-service/db";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
  type DeviceVerificationSender,
  notConfiguredVerificationSender,
} from "./devices/verification";
import { notConfiguredPushGateway, type PushGateway } from "./notifications/push";
import { ProblemError, problem } from "./problem";
import { registerRelayCredentials } from "./routes/credentials";
import { registerDevices } from "./routes/devices";
import { registerEnrollment } from "./routes/enrollment";
import { registerHealth } from "./routes/health";
import { registerNotifications, SEND_BUDGET_MS } from "./routes/notifications";
import { registerSettings } from "./routes/settings";

export type AppEnv = { Bindings: Env; Variables: { requestId: string } };

/** `requireSession` を付けた入口だけで使える `c.get("session")`。 */
export type SessionEnv = {
  Bindings: Env;
  Variables: { requestId: string; session: ActiveSession };
};

/** `requireRelayCredential` を付けた入口だけで使える `c.get("relayCredential")`。送り先のアカウントは、これだけで決める。 */
export type RelayEnv = {
  Bindings: Env;
  Variables: { requestId: string; relayCredential: ActiveRelayCredential };
};

/** 本文の大きさの上限 (設計書 §4)。 */
export const MAX_BODY_BYTES = 4 * 1024;

/** Hono が投げる HTTPException (壊れた JSON の 400、違う Content-Type の 415 など) の題。 */
const CLIENT_ERROR_TITLES: Partial<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
};

const requestId = createMiddleware<AppEnv>(async (c, next) => {
  // 送り手の X-Request-Id は使わない。送り手がログの request_id を決められると、ほかの要求のログに紛れ込ませられるため。
  const id = crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
});

export type AppOptions = {
  /** 端末の確かめの push を送る。既定では送らない。entrypoint は APNs の実装を渡し、テストでは差し替える。 */
  sendDeviceVerification?: DeviceVerificationSender;
  /** 端末へ通知を送る。既定では送らない。entrypoint は APNs の実装を渡し、テストでは差し替える。 */
  push?: PushGateway;
  /** 1 つのイベントで端末へ送る時間の上限 (ミリ秒)。テストで短くする。 */
  relaySendBudgetMs?: number;
};

export function createApp(options: AppOptions = {}) {
  const app = new OpenAPIHono<AppEnv>({
    // 入力の誤りは 422 の problem+json で返す。どの値がどう違うかは返さない (送られた値を応答に写さないため)。
    defaultHook: (result, c) => {
      if (!result.success)
        return problem(c, 422, "Unprocessable Content", "The request body is invalid.");
    },
  });
  app.use(requestId);
  // 応答には、セッション、中継の資格情報、チャレンジが入る。途中の cache やブラウザに残させない。
  app.use("/v1/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use(
    "/v1/*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => problem(c, 413, "Content Too Large") }),
  );
  // 認証の形 (OpenAPI の文書に書く)。どちらも Authorization: Bearer で送る。
  app.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "http",
    scheme: "bearer",
    description: "アカウントのセッション (tss_…、1 時間。ADR-0006)",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "relay", {
    type: "http",
    scheme: "bearer",
    description: "中継の資格情報 (tsr_…。利用者の Worker が使う。ADR-0007)",
  });
  registerHealth(app);
  registerEnrollment(app);
  registerRelayCredentials(app);
  registerSettings(app, options.push ?? notConfiguredPushGateway);
  registerDevices(app, options.sendDeviceVerification ?? notConfiguredVerificationSender);
  registerNotifications(
    app,
    options.push ?? notConfiguredPushGateway,
    options.relaySendBudgetMs ?? SEND_BUDGET_MS,
  );

  app.notFound((c) => problem(c, 404, "Not Found"));
  app.onError((error, c) => {
    if (error instanceof ProblemError)
      return problem(c, error.status, error.title, error.detail, error.headers);
    // Hono の入力の誤り (壊れた JSON、違う Content-Type)。文 (message) は返さず、状態の題だけにする。
    if (error instanceof HTTPException && error.status < 500)
      return problem(c, error.status, CLIENT_ERROR_TITLES[error.status] ?? "Bad Request");
    // エラーの文 (message) はログにも応答にも出さない。外部の API のエラーの文に、トークンや秘密が入ることがあるため。
    console.error(
      JSON.stringify({
        event: "unhandled_error",
        request_id: c.get("requestId"),
        name: error.name,
      }),
    );
    return problem(c, 500, "Internal Server Error");
  });
  return app;
}
