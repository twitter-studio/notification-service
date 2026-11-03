import { z } from "zod";

// APNs のデバイストークンを、DB に平文で置かないための暗号化と、一意にするための指紋 (ADR-0005)。

const CIPHERTEXT_VERSION = "v1";
// 暗号文を、この用途 (デバイストークン) だけに結びつける。ほかの用途の暗号文を、デバイストークンとして読ませないため。
const ADDITIONAL_DATA = new TextEncoder().encode("twitter-studio/apns-device-token/v1");
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_BYTES = 32;

export class DeviceTokenError extends Error {}

/** APNs のデバイストークン (16 進数) を、小文字にそろえて確かめる。形が違えば投げる。 */
export function normalizeDeviceToken(token: string): string {
  // Apple はトークンの長さを決めていないので、長さは範囲で確かめる (今は 32 バイト)。
  if (!/^(?:[0-9a-fA-F]{2}){16,128}$/.test(token))
    throw new DeviceTokenError("invalid device token");
  return token.toLowerCase();
}

export type TokenKeyring = { currentKeyId: string; keys: ReadonlyMap<string, CryptoKey> };

const KeyringSchema = z.object({
  current: z.string().regex(KEY_ID),
  keys: z.record(z.string().regex(KEY_ID), z.string()),
});

/**
 * 鍵束を、秘密 (`DEVICE_TOKEN_KEYS`) の JSON から読む。形: `{"current":"k1","keys":{"k1":"<32 バイトの Base64>"}}`。
 * 鍵を入れ替えるときは、新しい鍵を足して current にし、古い鍵は、古い暗号文を読めるよう残す。
 * エラーの文には、鍵の値を入れない。
 */
export async function loadTokenKeyring(json: string): Promise<TokenKeyring> {
  let parsed: z.infer<typeof KeyringSchema>;
  try {
    parsed = KeyringSchema.parse(JSON.parse(json));
  } catch {
    throw new DeviceTokenError("invalid DEVICE_TOKEN_KEYS");
  }
  const keys = new Map<string, CryptoKey>();
  for (const [id, encoded] of Object.entries(parsed.keys)) {
    keys.set(
      id,
      await crypto.subtle.importKey("raw", decodeKey(encoded, id), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    );
  }
  if (!keys.has(parsed.current))
    throw new DeviceTokenError("DEVICE_TOKEN_KEYS: current key is missing");
  return { currentKeyId: parsed.current, keys };
}

/** 指紋の鍵を、秘密 (`DEVICE_TOKEN_FINGERPRINT_KEY`、32 バイトの Base64) から読む。 */
export async function loadFingerprintKey(encoded: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decodeKey(encoded, "fingerprint"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** 今の鍵で暗号化する。同じトークンでも、毎回違う暗号文になる (IV が毎回違う)。 */
export async function encryptDeviceToken(keyring: TokenKeyring, token: string): Promise<string> {
  const key = keyring.keys.get(keyring.currentKeyId);
  if (key === undefined) throw new DeviceTokenError("current key is missing");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA },
    key,
    new TextEncoder().encode(normalizeDeviceToken(token)),
  );
  return [
    CIPHERTEXT_VERSION,
    keyring.currentKeyId,
    toBase64Url(iv),
    toBase64Url(new Uint8Array(ciphertext)),
  ].join(".");
}

/** 暗号文に書かれた鍵の ID の鍵で読む。鍵がない、書き換えられているなどで読めなければ投げる。 */
export async function decryptDeviceToken(
  keyring: TokenKeyring,
  encrypted: string,
): Promise<string> {
  const [version, keyId, iv, ciphertext, ...rest] = encrypted.split(".");
  if (
    version !== CIPHERTEXT_VERSION ||
    keyId === undefined ||
    iv === undefined ||
    ciphertext === undefined ||
    rest.length > 0
  ) {
    throw new DeviceTokenError("invalid device token ciphertext");
  }
  const key = keyring.keys.get(keyId);
  if (key === undefined) throw new DeviceTokenError("unknown device token key");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: ADDITIONAL_DATA },
      key,
      fromBase64Url(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new DeviceTokenError("device token ciphertext cannot be decrypted");
  }
}

/** トークンの指紋 (HMAC-SHA256)。DB でトークンを一意にするのに使う。鍵がなければ、指紋からトークンを総当たりで探せない。 */
export async function fingerprintDeviceToken(key: CryptoKey, token: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalizeDeviceToken(token)),
  );
  return toBase64Url(new Uint8Array(signature));
}

function decodeKey(encoded: string, name: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    throw new DeviceTokenError(`key ${name} is not Base64`);
  }
  if (bytes.length !== KEY_BYTES)
    throw new DeviceTokenError(`key ${name} must be ${KEY_BYTES} bytes`);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    throw new DeviceTokenError("invalid device token ciphertext");
  }
}
