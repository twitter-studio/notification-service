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
 * IPv6 は /64 にまとめる。回線や VPS は 1 人に /64 を配るので、アドレスを変えるだけで制限を越えさせないため。
 * 手元とテストのように付かないときは、まとめて 1 つに数える。
 */
export function clientAddressKey(request: Request): string {
  const header = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // IPv4 を写した IPv6 (::ffff:192.0.2.1) は、IPv4 として数える (/64 にまとめると、すべての IPv4 が 1 つになる)。
  const address = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(header)?.[1] ?? header;
  const prefix = address.includes(":") ? ipv6Prefix64(address) : undefined;
  return prefix === undefined ? `ip:${address}` : `ip6:${prefix}::/64`;
}

/** IPv6 のアドレスの前の 64 ビット (4 つの区切り)。読めなければ undefined (アドレスのまま数える)。 */
export function ipv6Prefix64(address: string): string | undefined {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const [head = "", tail] = halves;
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  // 末尾の IPv4 の書き方 (::ffff:192.0.2.1 など) は、16 ビットの区切り 2 つとして数える。
  const last = tailGroups.at(-1) ?? (tail === undefined ? headGroups.at(-1) : undefined);
  const embeddedIpv4 = last?.includes(".") === true;
  const groupCount = headGroups.length + tailGroups.length + (embeddedIpv4 ? 1 : 0);
  if (tail === undefined ? groupCount !== 8 : groupCount > 7) return undefined;
  const groups = [...headGroups, ...Array<string>(8 - groupCount).fill("0"), ...tailGroups];
  const prefix = groups.slice(0, 4);
  if (!prefix.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":");
}
