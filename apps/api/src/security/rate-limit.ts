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
 * IPv6 は /64 にまとめる。回線や VPS は 1 人に /64 以上を配るので、アドレスを変えるだけで制限を越えさせないため。
 * IPv4 を写した IPv6 (::ffff:0:0/96) と NAT64 (64:ff9b::/96) は、書き方によらず IPv4 として数える。前の 64 ビットが 0 の
 * アドレス (IPv4 互換、ループバックなど) はまとめない。まとめると、ほかの書き方で届いた IPv4 の人が、1 つの単位を分け合う。
 * 手元とテストのように付かないとき、読めないときは、値のまま数える。
 */
export function clientAddressKey(request: Request): string {
  const header = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const groups = header.includes(":") ? parseIpv6(header) : undefined;
  if (groups === undefined) return `ip:${header}`;
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const ipv4Mapped = zero(0, 5) && groups[5] === 0xffff;
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6);
  if (ipv4Mapped || nat64) {
    const [high = 0, low = 0] = groups.slice(6);
    return `ip:${[high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")}`;
  }
  const hex = groups.map((group) => group.toString(16));
  if (zero(0, 4)) return `ip6:${hex.join(":")}`;
  return `ip6:${hex.slice(0, 4).join(":")}::/64`;
}

/** IPv6 のアドレスを、16 ビットの区切り 8 つに読む (省略の `::`、末尾の IPv4 の書き方も読む)。読めなければ undefined。 */
export function parseIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parts = halves.map((half) => (half === "" ? [] : half.split(":")));
  const [head = [], tail] = parts;
  const lastPart = (tail ?? head).at(-1);
  // 末尾の IPv4 の書き方 (192.0.2.1) は、16 ビットの区切り 2 つにする。
  const ipv4 = lastPart?.includes(".") ? parseIpv4(lastPart) : undefined;
  if (lastPart?.includes(".") && ipv4 === undefined) return undefined;
  const toGroups = (texts: string[]) =>
    texts.map((text) => (/^[0-9a-fA-F]{1,4}$/.test(text) ? Number.parseInt(text, 16) : Number.NaN));
  const withIpv4 = (texts: string[], isLast: boolean) => {
    if (!isLast || ipv4 === undefined) return toGroups(texts);
    return [...toGroups(texts.slice(0, -1)), (ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]];
  };
  const headGroups = withIpv4(head, tail === undefined);
  const tailGroups = tail === undefined ? [] : withIpv4(tail, true);
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const groups = [...headGroups, ...Array<number>(missing).fill(0), ...tailGroups];
  return groups.every((group) => Number.isInteger(group)) ? groups : undefined;
}

function parseIpv4(text: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (match === null) return undefined;
  const octets = match.slice(1).map(Number);
  if (!octets.every((octet) => octet <= 255)) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return [a, b, c, d];
}
