import type { BearerTokenHash } from "@notification-service/db";
import { toBase64Url } from "./encoding";

// セッションと中継の資格情報 (高エントロピーの bearer)。DB にはハッシュだけを置き、平文は作ったときに 1 回だけ返す (ADR-0006)。
// 32 バイトの乱数なので、鍵のない SHA-256 で十分 (総当たりで探せない)。秘密の走査で見つけやすいよう、頭に用途の印を付ける。

/** session と relay は bearer、verification は端末のトークンを持っていることの確かめの code (push で送る)。 */
export type BearerKind = "session" | "relay" | "verification";

const PREFIX: Record<BearerKind, string> = { session: "tss_", relay: "tsr_", verification: "tsv_" };

export function newBearerToken(kind: BearerKind): string {
  return `${PREFIX[kind]}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** トークンのハッシュ (SHA-256 の Base64URL、43 文字)。DB に置くのは、これだけ。 */
export async function hashBearerToken(token: string): Promise<BearerTokenHash> {
  return toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
  ) as BearerTokenHash;
}

/** 2 つの文字列が同じか、かかる時間で中身を探られない形で比べる (ハッシュにそろえてから比べる)。 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all(
    [a, b].map(
      async (value) =>
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    ),
  );
  if (left === undefined || right === undefined) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}
