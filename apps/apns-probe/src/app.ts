import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { configuration, evidence, reasons } from "./schema";

type Configuration = z.infer<typeof configuration>;
type ProbeEnv = {
  Bindings: Env;
  Variables: { requestId: string; configuration: Configuration };
};
const errorResponse = {
  description: "秘密や要求の値を含まない problem details。",
  content: {
    "application/problem+json": {
      schema: z.object({
        type: z.literal("about:blank"),
        title: z.string(),
        status: z.number().int(),
        request_id: z.uuid(),
      }),
    },
  },
};
const route = createRoute({
  method: "post",
  path: "/probe",
  operationId: "probeSandboxApns",
  security: [{ probe: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              device_token: z
                .string()
                .regex(/^(?:[0-9a-f]{2}){16,128}$/)
                .brand<"ApnsDeviceToken">(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    400: errorResponse,
    401: errorResponse,
    413: errorResponse,
    415: errorResponse,
    422: errorResponse,
    500: errorResponse,
    200: {
      description: "APNs に1回だけ送った結果。端末への到達は別に確認する。",
      content: { "application/json": { schema: evidence } },
    },
  },
});

function problem(c: Context<ProbeEnv>, status: 400 | 401 | 404 | 413 | 415 | 422 | 500) {
  if (status === 401) c.header("WWW-Authenticate", 'Bearer realm="apns-probe"');
  return c.newResponse(
    JSON.stringify({
      type: "about:blank",
      title: "Probe request failed",
      status,
      request_id: c.get("requestId"),
    }),
    status,
    { "Content-Type": "application/problem+json" },
  );
}

const authenticate = createMiddleware<ProbeEnv>(async (c, next) => {
  const parsed = configuration.safeParse(c.env);
  const supplied = c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!parsed.success || supplied === undefined) return problem(c, 401);
  const until = Date.parse(parsed.data.PROBE_EXPIRES_AT);
  const remaining = until - Date.now();
  if (remaining <= 0 || remaining > 15 * 60 * 1000) return problem(c, 401);
  const [left, right] = await Promise.all(
    [supplied, parsed.data.PROBE_AUTH_TOKEN].map(async (value) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
  if (left === undefined || right === undefined || !crypto.subtle.timingSafeEqual(left, right))
    return problem(c, 401);
  c.set("configuration", parsed.data);
  await next();
});

async function apnsReason(response: Response): Promise<z.infer<typeof reasons> | null> {
  if (response.status === 200) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "other";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1024) return "other";
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const parsed = z.object({ reason: reasons }).safeParse(body);
    return parsed.success ? parsed.data.reason : "other";
  } catch {
    return "other";
  } finally {
    await reader.cancel();
  }
}

export function createProbe(send: typeof fetch = fetch) {
  const app = new OpenAPIHono<ProbeEnv>({
    defaultHook: (result, c) => (result.success ? undefined : problem(c, 422)),
  });
  app.use(async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) =>
    problem(
      c,
      error instanceof HTTPException &&
        (error.status === 400 || error.status === 413 || error.status === 415)
        ? error.status
        : 500,
    ),
  );
  app.notFound((c) => problem(c, 404));
  app.openAPIRegistry.registerComponent("securitySchemes", "probe", {
    type: "http",
    scheme: "bearer",
  });
  app.use("/probe", authenticate, bodyLimit({ maxSize: 512, onError: (c) => problem(c, 413) }));
  app.openapi(route, async (c) => {
    const started = performance.now();
    const requestId = c.get("requestId");
    const summary = () => ({
      request_id: requestId,
      elapsed_ms: Math.max(0, performance.now() - started),
      http_protocol: "not_exposed" as const,
      cpu_ms: null,
    });
    try {
      const response = await send(
        `https://api.sandbox.push.apple.com/3/device/${c.req.valid("json").device_token}`,
        {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: `bearer ${c.get("configuration").APNS_PROVIDER_TOKEN}`,
            "apns-topic": "com.twitter-studio.Tweetbot",
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": "0",
            "apns-id": requestId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            aps: {
              alert: { title: "Tweetbot", body: "APNs sandbox delivery check." },
              sound: "default",
            },
          }),
        },
      );
      const reason = await apnsReason(response);
      const id = z.uuid().safeParse(response.headers.get("apns-id"));
      const result = {
        kind: "apns_response",
        ...summary(),
        status: response.status,
        apns_id: id.success ? id.data : null,
        reason,
      } satisfies z.infer<typeof evidence>;
      return c.json(result, 200);
    } catch {
      // fetch の例外には送信先 URL (デバイストークン) が入ることがあるため、本文やログへ転記しない。
      const result = { kind: "transport_error", ...summary() } satisfies z.infer<typeof evidence>;
      return c.json(result, 200);
    }
  });
  return app;
}

export function openApiDocument(app = createProbe()) {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "Sandbox APNs probe", version: "1.0.0" },
  });
}
