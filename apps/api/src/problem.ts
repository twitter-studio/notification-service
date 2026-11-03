import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** RFC 9457 の problem details。エラーの応答は、すべてこの形にする (設計書 §4)。 */
export type Problem = {
  type: string;
  title: string;
  status: ContentfulStatusCode;
  detail?: string;
  request_id: string;
};

export function problem(
  c: Context,
  status: ContentfulStatusCode,
  title: string,
  detail?: string,
  headers: Record<string, string> = {},
): Response {
  const body: Problem = {
    type: "about:blank",
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    request_id: c.get("requestId"),
  };
  return c.body(JSON.stringify(body), status, {
    ...headers,
    "Content-Type": "application/problem+json",
  });
}

/**
 * 型の付いた入口 (zod-openapi) の中から、problem+json の応答を返すための例外。入口が返すのは宣言した成功の応答だけにし、
 * 失敗はこれを投げて、アプリのエラーの処理 (app.ts の onError) で problem+json にする。
 */
export class ProblemError extends Error {
  override name = "ProblemError";
  constructor(
    readonly status: ContentfulStatusCode,
    readonly title: string,
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(title);
  }
}
