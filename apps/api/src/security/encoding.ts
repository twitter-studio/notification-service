/** Base64URL (余白の `=` なし)。 */
export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Base64URL を読む。使えない文字があれば undefined (atob は空白を読み飛ばすので、使う前に文字を確かめる)。 */
export function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return undefined;
  try {
    return Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

/** 32 バイトの Base64 (秘密の鍵) を読む。形が違えば undefined。 */
export function decodeKey32(encoded: string | undefined): Uint8Array<ArrayBuffer> | undefined {
  if (encoded === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}
