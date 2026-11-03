/** Base64URL (余白の `=` なし)。 */
export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Base64URL を読む。`toBase64Url` が書く形 (余白の `=` なし、最後の文字の使わないビットが 0) でなければ undefined。
 * 同じバイト列の書き方を 1 つに決める。公開鍵の文字列で同じ鍵かを比べるため、書き方が違うだけの同じ鍵を、別の鍵として登録させない。
 * atob は空白を読み飛ばし、使わないビットを見ないので、読んだあとに書き直して比べる。
 */
export function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return undefined;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
  return toBase64Url(bytes) === encoded ? bytes : undefined;
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
