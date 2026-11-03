import type {
  ApnsEnvironment,
  DeviceTokenCiphertext,
  DeviceTokenFingerprint,
} from "@notification-service/db";
import { z } from "zod";

// APNs のデバイストークンを、DB に平文で置かないための暗号化と、一意にするための指紋 (ADR-0005)。

const CIPHERTEXT_VERSION = "v1";
const FINGERPRINT_VERSION = "f1";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_CHECK_CONTEXT = new TextEncoder().encode("twitter-studio/key-check/v1");

/** 端末から来たトークンの形が違う (要求の誤り。422)。 */
export class InvalidDeviceTokenError extends Error {
  override name = "InvalidDeviceTokenError";
}

/** 鍵の設定の誤り (秘密や設定の打ち間違いなど。500)。 */
export class DeviceTokenKeyError extends Error {
  override name = "DeviceTokenKeyError";
}

/** DB の暗号文を読めない (書き換えられた、鍵がない、行と合わないなど。500)。 */
export class DeviceTokenCiphertextError extends Error {
  override name = "DeviceTokenCiphertextError";
}

/** 暗号文を結び付ける端末の行 (ADR-0005)。行ごとに 1 つのトークンなので、ほかの行に写した暗号文は読めない。 */
export type DeviceTokenBinding = {
  installationId: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

export type DeviceTokenKeys = {
  currentKeyId: string;
  /** 鍵の ID ごとの鍵。current の鍵だけが暗号化にも使え、ほかは読むだけ。 */
  keys: ReadonlyMap<string, CryptoKey>;
  fingerprintKey: CryptoKey;
};

export type DeviceTokenKeyEnv = {
  DEVICE_TOKEN_KEYS: string;
  DEVICE_TOKEN_FINGERPRINT_KEY: string;
  DEVICE_TOKEN_KEY_CHECKS: string;
};

const KeyringSchema = z.object({
  current: z.string().regex(KEY_ID),
  keys: z.record(z.string().regex(KEY_ID), z.string()),
});

const KeyChecksSchema = z.object({
  fingerprint: z.string(),
  keys: z.record(z.string().regex(KEY_ID), z.string()),
});

/** 鍵の確かめの値 (16 進数 16 文字)。秘密ではない設定 (`DEVICE_TOKEN_KEY_CHECKS`) に置き、打ち間違えた鍵に気づくのに使う。 */
export async function keyCheckValue(key: Uint8Array<ArrayBuffer>): Promise<string> {
  const data = new Uint8Array(KEY_CHECK_CONTEXT.length + key.length);
  data.set(KEY_CHECK_CONTEXT);
  data.set(key, KEY_CHECK_CONTEXT.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 秘密 (`DEVICE_TOKEN_KEYS`、`DEVICE_TOKEN_FINGERPRINT_KEY`) と、鍵の確かめの値 (`DEVICE_TOKEN_KEY_CHECKS`) から鍵を読む。
 * 鍵ごとに確かめの値と比べ、合わなければ投げる (打ち間違えた古い鍵で、古い暗号文が読めなくなるのに気づけないため)。
 * エラーの文には、鍵の値を入れない。
 */
export async function loadDeviceTokenKeys(env: DeviceTokenKeyEnv): Promise<DeviceTokenKeys> {
  const keyring = parseJson(KeyringSchema, env.DEVICE_TOKEN_KEYS, "DEVICE_TOKEN_KEYS");
  const checks = parseJson(KeyChecksSchema, env.DEVICE_TOKEN_KEY_CHECKS, "DEVICE_TOKEN_KEY_CHECKS");
  // 添字 (keyring.keys[current]) で確かめると、current が "constructor" などのときに、オブジェクトの元の値で通ってしまう。
  if (!Object.hasOwn(keyring.keys, keyring.current)) {
    throw new DeviceTokenKeyError("DEVICE_TOKEN_KEYS: current key is missing");
  }

  const encryptionKeyChecks = new Set<string>();
  const keys = new Map<string, CryptoKey>();
  for (const [id, encoded] of Object.entries(keyring.keys)) {
    const bytes = decodeKey(encoded, `DEVICE_TOKEN_KEYS.${id}`);
    const check = await keyCheckValue(bytes);
    if (checks.keys[id] !== check)
      throw new DeviceTokenKeyError(`DEVICE_TOKEN_KEYS.${id} does not match its key check`);
    encryptionKeyChecks.add(check);
    // current 以外の鍵は読むだけに使う。入れ替えた後に、古い鍵で新しい暗号文を作らないため。
    const usages: ("encrypt" | "decrypt")[] =
      id === keyring.current ? ["encrypt", "decrypt"] : ["decrypt"];
    keys.set(id, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages));
  }

  const fingerprintBytes = decodeKey(
    env.DEVICE_TOKEN_FINGERPRINT_KEY,
    "DEVICE_TOKEN_FINGERPRINT_KEY",
  );
  const fingerprintCheck = await keyCheckValue(fingerprintBytes);
  if (checks.fingerprint !== fingerprintCheck) {
    throw new DeviceTokenKeyError("DEVICE_TOKEN_FINGERPRINT_KEY does not match its key check");
  }
  if (encryptionKeyChecks.has(fingerprintCheck)) {
    throw new DeviceTokenKeyError(
      "DEVICE_TOKEN_FINGERPRINT_KEY must differ from the encryption keys",
    );
  }
  const fingerprintKey = await crypto.subtle.importKey(
    "raw",
    fingerprintBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { currentKeyId: keyring.current, keys, fingerprintKey };
}

/** APNs のデバイストークン (16 進数) を、小文字にそろえて確かめる。形が違えば投げる。 */
export function normalizeDeviceToken(token: string): string {
  // Apple はトークンの長さを決めていないので、長さは範囲で確かめる (今は 32 バイト)。末尾の改行なども受け付けない。
  if (!/^(?:[0-9a-fA-F]{2}){16,128}$/.test(token))
    throw new InvalidDeviceTokenError("invalid device token");
  return token.toLowerCase();
}

/** トークンの指紋 (`f1.<HMAC-SHA256>`)。DB でトークンを一意にするのに使う。鍵がなければ、指紋からトークンを総当たりで探せない。 */
export async function fingerprintDeviceToken(
  keys: DeviceTokenKeys,
  token: string,
): Promise<DeviceTokenFingerprint> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    keys.fingerprintKey,
    new TextEncoder().encode(normalizeDeviceToken(token)),
  );
  return `${FINGERPRINT_VERSION}.${toBase64Url(new Uint8Array(signature))}` as DeviceTokenFingerprint;
}

/** トークンを、端末の行に結び付けて暗号化し、指紋と一緒に返す。同じトークンでも、毎回違う暗号文になる (IV が毎回違う)。 */
export async function sealDeviceToken(
  keys: DeviceTokenKeys,
  token: string,
  binding: DeviceTokenBinding,
): Promise<{ ciphertext: DeviceTokenCiphertext; fingerprint: DeviceTokenFingerprint }> {
  const normalized = normalizeDeviceToken(token);
  const key = keys.keys.get(keys.currentKeyId);
  if (key === undefined) throw new DeviceTokenKeyError("current key is missing");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(keys.currentKeyId, binding) },
    key,
    new TextEncoder().encode(normalized),
  );
  return {
    ciphertext: [
      CIPHERTEXT_VERSION,
      keys.currentKeyId,
      toBase64Url(iv),
      toBase64Url(new Uint8Array(ciphertext)),
    ].join(".") as DeviceTokenCiphertext,
    fingerprint: await fingerprintDeviceToken(keys, normalized),
  };
}

/**
 * 端末の行の暗号文を読み、トークンを返す。行の指紋と、読んだトークンの指紋が合うことも確かめる。
 * 鍵がない、書き換えられている、ほかの行から写されたなどで読めなければ投げる。
 */
export async function openDeviceToken(
  keys: DeviceTokenKeys,
  stored: DeviceTokenBinding & { ciphertext: string; fingerprint: string },
): Promise<string> {
  const parts = stored.ciphertext.split(".");
  const [version, keyId, ivText, bodyText] = parts;
  if (
    parts.length !== 4 ||
    version !== CIPHERTEXT_VERSION ||
    keyId === undefined ||
    ivText === undefined ||
    bodyText === undefined
  ) {
    throw new DeviceTokenCiphertextError("invalid device token ciphertext");
  }
  const key = keys.keys.get(keyId);
  if (key === undefined) throw new DeviceTokenCiphertextError("unknown device token key");
  const iv = fromBase64Url(ivText);
  const body = fromBase64Url(bodyText);
  if (iv.length !== IV_BYTES || body.length <= GCM_TAG_BYTES)
    throw new DeviceTokenCiphertextError("invalid device token ciphertext");

  let token: string;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(keyId, stored) },
      key,
      body,
    );
    token = normalizeDeviceToken(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext),
    );
  } catch {
    throw new DeviceTokenCiphertextError("device token ciphertext cannot be decrypted");
  }
  if ((await fingerprintDeviceToken(keys, token)) !== stored.fingerprint) {
    throw new DeviceTokenCiphertextError("device token does not match its fingerprint");
  }
  return token;
}

/** 追加の認証データ。用途、版、鍵の ID、端末の行 (インストール、環境、topic) に暗号文を結び付ける。 */
function additionalData(keyId: string, binding: DeviceTokenBinding): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      "twitter-studio/apns-device-token",
      CIPHERTEXT_VERSION,
      keyId,
      binding.installationId,
      binding.apnsEnvironment,
      binding.topic,
    ]),
  );
}

function parseJson<T>(schema: z.ZodType<T>, json: string, name: string): T {
  try {
    return schema.parse(JSON.parse(json));
  } catch {
    throw new DeviceTokenKeyError(`invalid ${name}`);
  }
}

function decodeKey(encoded: string | undefined, name: string): Uint8Array<ArrayBuffer> {
  // 秘密を置き忘れたとき (undefined) や長さの合わない Base64 も、鍵の設定の誤りとして扱う。
  if (encoded === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new DeviceTokenKeyError(`${name} is not Base64`);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    throw new DeviceTokenKeyError(`${name} is not Base64`);
  }
  if (bytes.length !== KEY_BYTES)
    throw new DeviceTokenKeyError(`${name} must be ${KEY_BYTES} bytes`);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  // atob は空白を読み飛ばすので、使う前に文字を確かめる。
  if (!BASE64URL.test(encoded))
    throw new DeviceTokenCiphertextError("invalid device token ciphertext");
  try {
    return Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    throw new DeviceTokenCiphertextError("invalid device token ciphertext");
  }
}
