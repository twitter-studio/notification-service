import { ProblemError } from "../problem";

// 登録とセッションの回数の制限 (ADR-0006)。Workers の Rate Limiting のバインディングで数える。
// 数は Cloudflare の場所ごとのおおよその数で、少し超えることがある。総当たりと D1 の書き込みの使い切りを遅らせるためのもので、
// 正確な上限が要るもの (課金など) には使わない。

/** 制限を超えたら 429 を投げる。`key` は、数える単位 (IP、インストール) と用途を含めた文字列。 */
export async function enforceRateLimit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) {
    // 数える期間 (wrangler.jsonc の period) は 60 秒。
    throw new ProblemError(429, "Too Many Requests", undefined, { "Retry-After": "60" });
  }
}

/**
 * 名前を名乗らない入口 (チャレンジ、登録、セッションの作り直し) で数える単位。Cloudflare が付ける接続元の IP。
 * Rate Limiting の文書は、IP は多くの人で共有されうるので単位に勧めていないが、この入口には、ほかに数える単位がない。
 * 手元とテストのように付かないときは、まとめて 1 つに数える。
 */
export function clientAddressKey(request: Request): string {
  return `ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
}
