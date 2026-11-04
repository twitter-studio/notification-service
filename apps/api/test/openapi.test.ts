import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openApiDocument } from "../src/openapi";
import { jsonHeaders } from "./helpers/http";

describe("OpenAPI の文書", () => {
  it("所有確認の成功は必ず端末を返し、設定の端末だけが null を許す", () => {
    const schemas = openApiDocument(createApp()).components?.schemas;
    expect(schemas?.Device).toMatchObject({ type: "object" });
    expect(schemas?.NotificationSettings).toMatchObject({
      properties: { device: { type: ["object", "null"] } },
    });
  });

  it("リポジトリに置いた openapi.json と同じ (API を変えたら、pnpm --filter @notification-service/api openapi で作り直す)", async () => {
    const document = openApiDocument(createApp());

    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot("../openapi.json");
  });

  it("セッションと中継の資格情報の要る入口に、認証の形を書く", () => {
    const { paths = {} } = openApiDocument(createApp());
    const security = (path: string, method: string) =>
      (paths[path] as Record<string, { security?: unknown }> | undefined)?.[method]?.security;

    expect(security("/v1/relay-credentials/rotate", "post")).toEqual([{ session: [] }]);
    expect(security("/v1/relay-credentials/{id}", "delete")).toEqual([{ session: [] }]);
    expect(security("/v1/devices/{id}", "put")).toEqual([{ session: [] }]);
    expect(security("/v1/devices/{id}/verification", "post")).toEqual([{ session: [] }]);
    expect(security("/v1/devices/{id}", "delete")).toEqual([{ session: [] }]);
    expect(security("/v1/settings", "get")).toEqual([{ session: [] }]);
    expect(security("/v1/account", "delete")).toEqual([{ session: [] }]);
    expect(security("/v1/notifications/test", "post")).toEqual([{ session: [] }]);
    expect(security("/v1/notifications", "post")).toEqual([{ relay: [] }]);
    expect(security("/v1/enrollments", "post")).toBeUndefined();
  });

  it("Authorization なしで 401 を返す入口と、文書で認証の形を書いた入口が一致する", async () => {
    const app = createApp();
    const { paths = {} } = openApiDocument(app);
    const operations = Object.entries(paths).flatMap(([path, methods]) =>
      Object.entries(methods as Record<string, { security?: unknown }>).map(
        ([method, operation]) => ({
          path,
          method,
          documented: operation.security !== undefined,
        }),
      ),
    );

    const results = await Promise.all(
      operations.map(async ({ path, method, documented }) => {
        const response = await app.request(
          `https://notification.test${path.replaceAll("{id}", crypto.randomUUID())}`,
          {
            method: method.toUpperCase(),
            headers: jsonHeaders(),
            body: method === "get" || method === "delete" ? null : "{}",
          },
          env,
        );
        return {
          operation: `${method.toUpperCase()} ${path}`,
          documented,
          unauthorized: response.status === 401,
          challenged: response.headers.has("WWW-Authenticate"),
        };
      }),
    );

    expect(operations.length).toBeGreaterThan(0);
    for (const result of results)
      expect(result).toEqual({
        operation: result.operation,
        documented: result.unauthorized,
        unauthorized: result.unauthorized,
        challenged: result.unauthorized,
      });
  });
});
