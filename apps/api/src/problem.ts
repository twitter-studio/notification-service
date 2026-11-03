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
): Response {
  const body: Problem = {
    type: "about:blank",
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    request_id: c.get("requestId"),
  };
  return c.body(JSON.stringify(body), status, { "Content-Type": "application/problem+json" });
}
