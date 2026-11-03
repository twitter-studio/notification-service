/**
 * テストの接続元の IP (文書用の 2001:db8::/32)。要求ごとに変え、IP ごとの回数の制限に、ほかのテストの要求を数えさせない
 * (Miniflare も制限を数える)。
 */
export function clientAddress(): string {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint16Array(2));
  return `2001:db8::${high.toString(16)}:${low.toString(16)}`;
}

export function jsonHeaders(address = clientAddress()): Record<string, string> {
  return { "Content-Type": "application/json", "CF-Connecting-IP": address };
}
