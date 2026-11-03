import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createDb,
  createSession,
  enrollInstallation,
  findActiveInstallation,
  isUniqueViolation,
} from "@notification-service/db";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { ProblemError } from "../problem";
import { constantTimeEquals, hashBearerToken, newBearerToken } from "../security/bearer";
import {
  InvalidChallengeError,
  issueChallenge,
  loadChallengeKey,
  verifyChallenge,
} from "../security/challenge";
import {
  enrollmentMessage,
  InvalidInstallationKeyError,
  parseInstallationPublicKey,
  sessionMessage,
  verifyInstallationSignature,
} from "../security/installation-key";
import { clientAddressKey, enforceRateLimit } from "../security/rate-limit";

// 端末の登録と、セッションの作り直し (設計書 §3 の手順 1〜3、ADR-0006)。

/** セッションの長さ。短くし、端末の鍵の署名で作り直す。 */
export const SESSION_TTL_MS = 60 * 60 * 1000;

const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    request_id: z.string(),
  })
  .openapi("Problem");

const problemResponse = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

/** どの入口でも返しうるエラー。 */
const commonProblems = {
  400: problemResponse("本文が JSON として読めない"),
  413: problemResponse("本文が 4 KiB を超える"),
  415: problemResponse("Content-Type が application/json でない"),
  422: problemResponse("入力の誤り"),
  429: problemResponse("回数の制限を超えた (Retry-After の秒数を待つ)"),
  500: problemResponse("サーバーの誤り"),
};

const SessionSchema = z.object({ token: z.string(), expires_at: z.string() }).openapi("Session");

const challengeRoute = createRoute({
  method: "post",
  path: "/v1/enrollments/challenge",
  summary: "登録かセッションの作り直しで、端末の鍵に署名させるチャレンジを出す",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: z.object({ purpose: z.enum(["enroll", "session"]) }) },
      },
    },
  },
  responses: {
    200: {
      description: "チャレンジ (5 分で期限切れ。1 回だけ使える)",
      content: {
        "application/json": {
          schema: z.object({ challenge: z.string(), expires_at: z.string() }).openapi("Challenge"),
        },
      },
    },
    ...commonProblems,
  },
});

const enrollRoute = createRoute({
  method: "post",
  path: "/v1/enrollments",
  summary: "端末を登録し、アカウント、セッション、中継の資格情報を作る",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              challenge: z.string().max(512),
              public_key: z.string().max(128),
              signature: z.string().max(128),
              invite_code: z.string().max(256),
            })
            .openapi("EnrollmentRequest"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "登録した。中継の資格情報 (relay_secret) は、この応答でだけ返す",
      content: {
        "application/json": {
          schema: z
            .object({
              account_id: z.string(),
              installation_id: z.string(),
              session: SessionSchema,
              relay_secret: z.string(),
              /** 中継の資格情報の ID。入れ替えと取り消し (AUTH-002) で、どの資格情報かを示すのに使う。 */
              relay_credential_id: z.string(),
            })
            .openapi("Enrollment"),
        },
      },
    },
    200: {
      description:
        "同じ鍵で、すでに登録していた。セッションだけを返す (中継の資格情報は入れ替えで作り直す。AUTH-002)",
      content: {
        "application/json": {
          schema: z
            .object({ account_id: z.string(), installation_id: z.string(), session: SessionSchema })
            .openapi("ExistingEnrollment"),
        },
      },
    },
    401: problemResponse("チャレンジか署名が正しくない"),
    403: problemResponse(
      "登録を受け付けていない、招待のコードが違う、または取り消したインストールか止めたアカウントの鍵",
    ),
    409: problemResponse("チャレンジはもう使われた"),
    ...commonProblems,
  },
});

const sessionRoute = createRoute({
  method: "post",
  path: "/v1/sessions",
  summary: "端末の鍵の署名で、セッションを作り直す",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              installation_id: z.uuid(),
              challenge: z.string().max(512),
              signature: z.string().max(128),
            })
            .openapi("SessionRequest"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "セッション",
      content: { "application/json": { schema: z.object({ session: SessionSchema }) } },
    },
    401: problemResponse("チャレンジ、インストール、署名のどれかが正しくない"),
    409: problemResponse("チャレンジはもう使われた"),
    ...commonProblems,
  },
});

async function newSession(now: Date) {
  const token = newBearerToken("session");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  return { token, expiresAt, record: { tokenHash: await hashBearerToken(token), expiresAt } };
}

/**
 * 招待のコードの形。16 バイト (128 ビット) 以上の乱数の Base64URL (22 文字以上)。総当たりで探せない長さにする。
 * 形だけを見るので、乱数で作るのはオーナーの手順 (ADR-0006) で守る。
 */
const INVITE_CODE_SHAPE = /^[A-Za-z0-9_-]{22,}$/;

/** P-256 の生成元の点。インストールがないときも、同じ手間の署名の確かめをして、かかる時間でインストールがあるかを探らせない。 */
const UNKNOWN_INSTALLATION_KEY = parseInstallationPublicKey(
  "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
);

/**
 * 招待のコードを確かめる。秘密 `ENROLLMENT_INVITE_CODE` がない、または短いときは、登録を受け付けない
 * (試作のあいだの制限。ADR-0006)。受け付けていないときとコードが違うときは、同じ応答にする (秘密を置いたかを探らせない)。
 */
async function checkInvite(c: Context<AppEnv>, inviteCode: string): Promise<void> {
  const expected = c.env.ENROLLMENT_INVITE_CODE;
  const open = expected !== undefined && INVITE_CODE_SHAPE.test(expected);
  if (expected !== undefined && expected.length > 0 && !open) {
    // 値は出さない。
    console.error(JSON.stringify({ event: "enrollment_invite_code_too_short" }));
  }
  if (!open || !(await constantTimeEquals(inviteCode, expected)))
    throw new ProblemError(403, "Forbidden", "Enrollment is not available.");
}

function challengeKey(env: Env): Promise<CryptoKey> {
  return loadChallengeKey(env.CHALLENGE_SIGNING_KEY, env.DEVICE_TOKEN_KEY_CHECKS);
}

export function registerEnrollment(app: OpenAPIHono<AppEnv>) {
  app.openapi(challengeRoute, async (c) => {
    await enforceRateLimit(c.env.CLIENT_RATE_LIMITER, clientAddressKey(c.req.raw));
    const { purpose } = c.req.valid("json");
    const issued = await issueChallenge(await challengeKey(c.env), purpose);
    return c.json({ challenge: issued.challenge, expires_at: issued.expiresAt.toISOString() }, 200);
  });

  app.openapi(enrollRoute, async (c) => {
    await enforceRateLimit(c.env.CLIENT_RATE_LIMITER, clientAddressKey(c.req.raw));
    const body = c.req.valid("json");
    await checkInvite(c, body.invite_code);

    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    let publicKey: Uint8Array<ArrayBuffer>;
    try {
      challenge = await verifyChallenge(await challengeKey(c.env), body.challenge, "enroll", now);
      publicKey = parseInstallationPublicKey(body.public_key);
    } catch (error) {
      if (error instanceof InvalidChallengeError)
        throw new ProblemError(401, "Unauthorized", "The challenge is invalid.");
      if (error instanceof InvalidInstallationKeyError)
        throw new ProblemError(422, "Unprocessable Content", "The public key is invalid.");
      throw error;
    }
    if (
      !(await verifyInstallationSignature(
        publicKey,
        enrollmentMessage(body.challenge, body.public_key),
        body.signature,
      ))
    ) {
      throw new ProblemError(401, "Unauthorized", "The signature is invalid.");
    }

    const db = createDb(c.env.DB);
    const relaySecret = newBearerToken("relay");
    const session = await newSession(now);
    try {
      const enrolled = await enrollInstallation(
        db,
        {
          publicKey: body.public_key,
          relaySecretHash: await hashBearerToken(relaySecret),
          challenge,
          session: session.record,
        },
        now,
      );
      const sessionBody = { token: session.token, expires_at: session.expiresAt.toISOString() };
      if (enrolled.created) {
        return c.json(
          {
            account_id: enrolled.accountId,
            installation_id: enrolled.installationId,
            session: sessionBody,
            relay_secret: relaySecret,
            relay_credential_id: enrolled.relayCredentialId,
          },
          201,
        );
      }
      // 同じ鍵で登録し直した (前の応答を受け取れなかったなど)。鍵を持っていることは署名で確かめたので、セッションだけを作る。
      const sessionId = await createSession(
        db,
        {
          accountId: enrolled.accountId,
          installationId: enrolled.installationId,
          challenge,
          session: session.record,
        },
        now,
      );
      if (sessionId === undefined)
        throw new ProblemError(401, "Unauthorized", "The installation is not active.");
      return c.json(
        {
          account_id: enrolled.accountId,
          installation_id: enrolled.installationId,
          session: sessionBody,
        },
        200,
      );
    } catch (error) {
      if (isUniqueViolation(error, "used_challenges.nonce"))
        throw new ProblemError(409, "Conflict", "The challenge has already been used.");
      if (isUniqueViolation(error, "installations.public_key")) {
        // 同じ鍵が、取り消したインストールか、止めたアカウントのものだった。消したアカウントのインストールの行は
        // 消してあるので、同じ鍵でも新しいアカウントとして登録できる (ADR-0006)。
        throw new ProblemError(403, "Forbidden", "The installation key cannot be enrolled.");
      }
      throw error;
    }
  });

  app.openapi(sessionRoute, async (c) => {
    await enforceRateLimit(c.env.CLIENT_RATE_LIMITER, clientAddressKey(c.req.raw));
    const body = c.req.valid("json");
    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    try {
      challenge = await verifyChallenge(await challengeKey(c.env), body.challenge, "session", now);
    } catch (error) {
      if (error instanceof InvalidChallengeError)
        throw new ProblemError(401, "Unauthorized", "The challenge is invalid.");
      throw error;
    }
    const db = createDb(c.env.DB);
    const installation = await findActiveInstallation(db, body.installation_id);
    // インストールがないときと、署名が違うときは、同じ応答にする (インストールの ID があるかを探られないため)。
    // ないときも、決まった鍵で署名を確かめ、かかる時間をそろえる。
    const verified = await verifyInstallationSignature(
      installation === undefined
        ? UNKNOWN_INSTALLATION_KEY
        : parseInstallationPublicKeyOrEmpty(installation.publicKey),
      sessionMessage(body.challenge, body.installation_id),
      body.signature,
    );
    if (installation === undefined || !verified)
      throw new ProblemError(401, "Unauthorized", "The credentials are invalid.");
    // 鍵を持つ端末が、セッションを作り直し続けるのを止める (署名を確かめた後に数え、ほかの人に枠を使わせない)。
    await enforceRateLimit(c.env.INSTALLATION_RATE_LIMITER, `installation:${body.installation_id}`);

    const session = await newSession(now);
    try {
      const sessionId = await createSession(
        db,
        {
          accountId: installation.accountId,
          installationId: body.installation_id,
          challenge,
          session: session.record,
        },
        now,
      );
      if (sessionId === undefined)
        throw new ProblemError(401, "Unauthorized", "The credentials are invalid.");
    } catch (error) {
      if (isUniqueViolation(error, "used_challenges.nonce"))
        throw new ProblemError(409, "Conflict", "The challenge has already been used.");
      throw error;
    }
    return c.json(
      { session: { token: session.token, expires_at: session.expiresAt.toISOString() } },
      201,
    );
  });
}

/** DB に置いた公開鍵 (登録のときに確かめた形) を読む。読めなければ空にし、署名の確かめで失敗させる。 */
function parseInstallationPublicKeyOrEmpty(encoded: string): Uint8Array<ArrayBuffer> {
  try {
    return parseInstallationPublicKey(encoded);
  } catch {
    return new Uint8Array(0);
  }
}
