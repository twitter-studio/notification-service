import { OpenAPIHono } from "@hono/zod-openapi";
import type { ActiveSession } from "@notification-service/db";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { ProblemError, problem } from "./problem";
import { registerEnrollment } from "./routes/enrollment";
import { registerHealth } from "./routes/health";

export type AppEnv = { Bindings: Env; Variables: { requestId: string; session: ActiveSession } };

/** 本文の大きさの上限 (設計書 §4)。 */
export const MAX_BODY_BYTES = 4 * 1024;

const requestId = createMiddleware<AppEnv>(async (c, next) => {
  // 送り手の X-Request-Id は使わない。送り手がログの request_id を決められると、ほかの要求のログに紛れ込ませられるため。
  const id = crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
});

export function createApp() {
  const app = new OpenAPIHono<AppEnv>({
    // 入力の誤りは 422 の problem+json で返す。どの値がどう違うかは返さない (送られた値を応答に写さないため)。
    defaultHook: (result, c) => {
      if (!result.success)
        return problem(c, 422, "Unprocessable Content", "The request body is invalid.");
    },
  });
  app.use(requestId);
  app.use(
    "/v1/*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => problem(c, 413, "Content Too Large") }),
  );
  registerHealth(app);
  registerEnrollment(app);

  app.notFound((c) => problem(c, 404, "Not Found"));
  app.onError((error, c) => {
    if (error instanceof ProblemError) return problem(c, error.status, error.title, error.detail);
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
