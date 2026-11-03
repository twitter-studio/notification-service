import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { problem } from "./problem";
import { registerHealth } from "./routes/health";

export type AppEnv = { Variables: { requestId: string } };

const requestId = createMiddleware<AppEnv>(async (c, next) => {
  // 送り手の X-Request-Id は使わない。送り手がログの request_id を決められると、ほかの要求のログに紛れ込ませられるため。
  const id = crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
});

export function createApp() {
  const app = new OpenAPIHono<AppEnv>();
  app.use(requestId);
  registerHealth(app);

  app.notFound((c) => problem(c, 404, "Not Found"));
  app.onError((error, c) => {
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
