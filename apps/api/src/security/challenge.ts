import { z } from "zod";
import { deviceTokenKeyCheckValues, keyCheckValue } from "./device-token";
import { decodeKey32, fromBase64Url, toBase64Url } from "./encoding";

// 登録とセッションの作り直しで、端末の鍵に署名させるチャレンジ (ADR-0006)。
// チャレンジはサーバーの秘密で署名した値で、出すときには DB に書かない。名前を名乗らない呼び出しで、D1 の書き込みを使わせないため。
// 使ったチャレンジは、使ったときに DB に記録し、2 回目を拒む。

const VERSION = "c1";
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/**
 * サーバーどうしの時計のずれとして許す幅。これを越えて先の期限のチャレンジは、作った覚えがないものとして拒む。
 * 使ったチャレンジの記録は、期限からこの幅を待ってから消す (遅れた時計のサーバーが、まだ期限内として受けるため)。
 */
export const CLOCK_SKEW_MS = 60 * 1000;

export type ChallengePurpose =
  | "enroll"
  | "session"
  | "relay_credential"
  | "device"
  | "delete_account";

/** チャレンジが壊れている、期限切れ、用途が違う (401)。 */
export class InvalidChallengeError extends Error {
  override name = "InvalidChallengeError";
}

/** チャレンジの署名の鍵の設定の誤り (500)。 */
export class ChallengeKeyError extends Error {
  override name = "ChallengeKeyError";
}

const PayloadSchema = z.object({
  v: z.literal(1),
  n: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  p: z.enum(["enroll", "session", "relay_credential", "device", "delete_account"]),
  e: z.number().int(),
});

/**
 * チャレンジの署名の鍵 (秘密 `CHALLENGE_SIGNING_KEY`、32 バイトの Base64) を読む。
 * デバイストークンの鍵 (`DEVICE_TOKEN_KEY_CHECKS` に確かめの値のあるもの) と同じ鍵なら投げる。用途ごとに鍵を分け、
 * 1 つが漏れても、ほかの用途に使わせないため。
 */
export async function loadChallengeKey(
  encoded: string | undefined,
  deviceTokenKeyChecks: string,
): Promise<CryptoKey> {
  const bytes = decodeKey32(encoded);
  if (bytes === undefined)
    throw new ChallengeKeyError("CHALLENGE_SIGNING_KEY must be 32 bytes of Base64");
  if (deviceTokenKeyCheckValues(deviceTokenKeyChecks).has(await keyCheckValue(bytes)))
    throw new ChallengeKeyError("CHALLENGE_SIGNING_KEY must differ from the device token keys");
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** 環境の秘密 (`CHALLENGE_SIGNING_KEY`) から、チャレンジの署名の鍵を読む。 */
export function challengeKeyFromEnv(env: Env): Promise<CryptoKey> {
  return loadChallengeKey(env.CHALLENGE_SIGNING_KEY, env.DEVICE_TOKEN_KEY_CHECKS);
}

/** 用途ごとのチャレンジを作る。形は `c1.<内容>.<HMAC>`。 */
export async function issueChallenge(
  key: CryptoKey,
  purpose: ChallengePurpose,
  now = new Date(),
): Promise<{ challenge: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ v: 1, n: nonce, p: purpose, e: expiresAt.getTime() }),
    ),
  );
  const signed = `${VERSION}.${payload}`;
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
  );
  return { challenge: `${signed}.${toBase64Url(mac)}`, expiresAt };
}

/** チャレンジを確かめ、使ったものとして記録するための nonce と期限を返す。壊れている、期限切れ、用途が違えば投げる。 */
export async function verifyChallenge(
  key: CryptoKey,
  challenge: string,
  purpose: ChallengePurpose,
  now = new Date(),
): Promise<{ nonce: string; expiresAt: Date }> {
  const parts = challenge.split(".");
  const [version, payloadText, macText] = parts;
  if (
    parts.length !== 3 ||
    version !== VERSION ||
    payloadText === undefined ||
    macText === undefined
  ) {
    throw new InvalidChallengeError("invalid challenge");
  }
  const mac = fromBase64Url(macText);
  const payloadBytes = fromBase64Url(payloadText);
  if (mac === undefined || payloadBytes === undefined)
    throw new InvalidChallengeError("invalid challenge");
  // HMAC は crypto.subtle.verify で比べる (かかる時間で、正しい値を探られないため)。
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    new TextEncoder().encode(`${VERSION}.${payloadText}`),
  );
  if (!valid) throw new InvalidChallengeError("invalid challenge");

  let payload: z.infer<typeof PayloadSchema>;
  try {
    payload = PayloadSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payloadBytes)),
    );
  } catch {
    throw new InvalidChallengeError("invalid challenge");
  }
  if (payload.p !== purpose) throw new InvalidChallengeError("challenge purpose does not match");
  if (payload.e <= now.getTime()) throw new InvalidChallengeError("challenge expired");
  if (payload.e > now.getTime() + CHALLENGE_TTL_MS + CLOCK_SKEW_MS)
    throw new InvalidChallengeError("invalid challenge");
  return { nonce: payload.n, expiresAt: new Date(payload.e) };
}
