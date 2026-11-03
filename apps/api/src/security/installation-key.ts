import { fromBase64Url } from "./encoding";

// 端末 (インストール) の鍵 (ECDSA P-256)。iOS の Secure Enclave (CryptoKit の SecureEnclave.P256.Signing) で作る (ADR-0006)。
// 公開鍵は X9.63 の非圧縮の点 (65 バイト、0x04 で始まる) の Base64URL、署名は r‖s の 64 バイト (CryptoKit の
// rawRepresentation) の Base64URL で受ける。署名する文は、用途と、署名の対象を、改行で区切って並べたもの。

/** 公開鍵の形が違う (422)。 */
export class InvalidInstallationKeyError extends Error {
  override name = "InvalidInstallationKeyError";
}

/** 公開鍵を確かめて読む。形が違えば投げる。 */
export function parseInstallationPublicKey(encoded: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64Url(encoded);
  if (bytes === undefined || bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new InvalidInstallationKeyError("invalid public key");
  }
  return bytes;
}

/** 登録で署名する文。チャレンジと公開鍵を結び付ける (ほかの鍵の登録に、署名を使い回させない)。 */
export function enrollmentMessage(challenge: string, publicKey: string): string {
  return ["twitter-studio/enroll/v1", challenge, publicKey].join("\n");
}

/** セッションの作り直しで署名する文。チャレンジとインストールを結び付ける。 */
export function sessionMessage(challenge: string, installationId: string): string {
  return ["twitter-studio/session/v1", challenge, installationId].join("\n");
}

/** 署名を確かめる。公開鍵が曲線の上の点でない、署名の形が違うときも false。 */
export async function verifyInstallationSignature(
  publicKey: Uint8Array<ArrayBuffer>,
  message: string,
  signature: string,
): Promise<boolean> {
  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes === undefined || signatureBytes.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signatureBytes,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}
