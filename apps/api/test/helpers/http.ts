/**
 * テストの接続元の IP (文書用の 2001:db8::/32)。要求ごとに /64 を変え、IP ごとの回数の制限 (IPv6 は /64 で数える) に、
 * ほかのテストの要求を数えさせない (Miniflare も制限を数える)。
 */
export function clientAddress(): string {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint16Array(2));
  return `2001:db8:${high.toString(16)}:${low.toString(16)}::1`;
}

export function jsonHeaders(address = clientAddress()): Record<string, string> {
  return { "Content-Type": "application/json", "CF-Connecting-IP": address };
}
