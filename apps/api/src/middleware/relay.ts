import {
  createDb,
  findActiveRelayCredential,
  markRelayCredentialUsed,
} from "@notification-service/db";
import { createMiddleware } from "hono/factory";
import type { RelayEnv } from "../app";
import { problem } from "../problem";
import { hashBearerToken } from "../security/bearer";

const RELAY_TOKEN = /^Bearer (tsr_[A-Za-z0-9_-]{43})$/;

/**
 * 中継の資格情報 (`Authorization: Bearer tsr_…`) を確かめ、`c.get("relayCredential")` に置く。確かめられなければ 401。
 * 送り先のアカウントは、この資格情報だけで決める (本文の ID では決めない。ADR-0001)。
 * トークンはハッシュにして DB の索引で引く。256 ビットの乱数なので、引く時間からハッシュの一部が分かっても、元の値は探せない。
 */
export const requireRelayCredential = createMiddleware<RelayEnv>(async (c, next) => {
  const token = RELAY_TOKEN.exec(c.req.header("Authorization") ?? "")?.[1];
  const db = createDb(c.env.DB);
  const credential =
    token === undefined
      ? undefined
      : await findActiveRelayCredential(db, await hashBearerToken(token));
  if (credential === undefined) {
    c.header("WWW-Authenticate", 'Bearer realm="notification-service"');
    return problem(c, 401, "Unauthorized");
  }
  // 使っていない資格情報を見つけられるよう、使った時刻を残す (1 時間に 1 回まで書く)。応答を待たせず、失敗しても中継は通す。
  const marking = markRelayCredentialUsed(db, {
    accountId: credential.accountId,
    credentialId: credential.id,
  }).catch(() => {
    console.error(
      JSON.stringify({
        event: "relay_credential_mark_used_failed",
        request_id: c.get("requestId"),
      }),
    );
  });
  try {
    c.executionCtx.waitUntil(marking);
  } catch {
    // 実行の文脈のない呼び出し (テストの app.request) では、待ってから進む。
    await marking;
  }
  c.set("relayCredential", credential);
  await next();
});
