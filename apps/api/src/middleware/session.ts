import { createDb, findActiveSession } from "@notification-service/db";
import { createMiddleware } from "hono/factory";
import type { SessionEnv } from "../app";
import { problem } from "../problem";
import { hashBearerToken } from "../security/bearer";

const SESSION_TOKEN = /^Bearer (tss_[A-Za-z0-9_-]{43})$/;

/** アカウントのセッション (`Authorization: Bearer tss_…`) を確かめ、`c.get("session")` に置く。確かめられなければ 401。 */
export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
  const token = SESSION_TOKEN.exec(c.req.header("Authorization") ?? "")?.[1];
  const session =
    token === undefined
      ? undefined
      : await findActiveSession(createDb(c.env.DB), await hashBearerToken(token));
  if (session === undefined) {
    c.header("WWW-Authenticate", 'Bearer realm="notification-service"');
    return problem(c, 401, "Unauthorized");
  }
  c.set("session", session);
  await next();
});
