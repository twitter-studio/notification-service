import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { openApiDocument } from "../src/openapi";

describe("OpenAPI の文書", () => {
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
    expect(security("/v1/notifications", "post")).toEqual([{ relay: [] }]);
    expect(security("/v1/enrollments", "post")).toBeUndefined();
  });
});
