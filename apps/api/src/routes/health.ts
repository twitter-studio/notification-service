import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

const HealthSchema = z.object({ status: z.literal("ok") }).openapi("Health");

const route = createRoute({
  method: "get",
  path: "/health",
  summary: "動いているかの確認",
  responses: {
    200: {
      description: "動いている",
      content: { "application/json": { schema: HealthSchema } },
    },
  },
});

// 返すのは状態だけにする。版や設定、秘密の有無を返すと、外から構成を探られる手がかりになるため。
export function registerHealth(app: OpenAPIHono) {
  app.openapi(route, (c) => c.json({ status: "ok" as const }, 200));
}
