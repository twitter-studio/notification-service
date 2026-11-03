import { toBase64Url } from "../../src/security/encoding";

/** テストの端末の鍵 (ECDSA P-256)。公開鍵は非圧縮の点、署名は r‖s の 64 バイト (iOS の CryptoKit と同じ形)。 */
export async function newDeviceKey() {
  // Workers の型は、鍵の組か 1 つの鍵かを区別しないので、ECDSA の鍵の組として扱う。
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // raw で書き出したものは ArrayBuffer (Workers の型は JWK と区別しない)。
  const publicKey = toBase64Url(
    new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
  );
  return {
    publicKey,
    async sign(message: string): Promise<string> {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(message),
      );
      return toBase64Url(new Uint8Array(signature));
    },
  };
}
