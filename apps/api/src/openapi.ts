import type { createApp } from "./app";

/**
 * 公開の API の OpenAPI 3.1 の文書 (設計書 §4)。アプリの Swift のクライアント (IOS-002) は、これから作る。
 * Worker の入口としては出さない (運営の API の形を外から探る手がかりにしないため)。リポジトリの openapi.json に置き、テストで比べる。
 */
export function openApiDocument(app: ReturnType<typeof createApp>) {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "notification-service",
      version: "1",
      description: "tweetbot の通知の中継 API (twitter-studio/notification-service)。",
    },
  });
}
