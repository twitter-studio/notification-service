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
    422: problemResponse("入力の誤り"),
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
    403: problemResponse("登録を受け付けていない、または招待のコードが違う"),
    409: problemResponse("チャレンジはもう使われた"),
    422: problemResponse("入力の誤り"),
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
              installation_id: z.string().max(64),
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
    422: problemResponse("入力の誤り"),
  },
});

async function newSession(now: Date) {
  const token = newBearerToken("session");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  return { token, expiresAt, record: { tokenHash: await hashBearerToken(token), expiresAt } };
}

/** 招待のコードを確かめる。秘密 `ENROLLMENT_INVITE_CODE` がなければ、登録を受け付けない (試作のあいだの制限。ADR-0006)。 */
async function checkInvite(c: Context<AppEnv>, inviteCode: string): Promise<void> {
  const expected = c.env.ENROLLMENT_INVITE_CODE;
  if (expected === undefined || expected.length === 0)
    throw new ProblemError(403, "Forbidden", "Enrollment is not open.");
  if (!(await constantTimeEquals(inviteCode, expected)))
    throw new ProblemError(403, "Forbidden", "The invite code is invalid.");
}

export function registerEnrollment(app: OpenAPIHono<AppEnv>) {
  app.openapi(challengeRoute, async (c) => {
    const { purpose } = c.req.valid("json");
    const issued = await issueChallenge(
      await loadChallengeKey(c.env.CHALLENGE_SIGNING_KEY),
      purpose,
    );
    return c.json({ challenge: issued.challenge, expires_at: issued.expiresAt.toISOString() }, 200);
  });

  app.openapi(enrollRoute, async (c) => {
    const body = c.req.valid("json");
    await checkInvite(c, body.invite_code);

    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    let publicKey: Uint8Array<ArrayBuffer>;
    try {
      challenge = await verifyChallenge(
        await loadChallengeKey(c.env.CHALLENGE_SIGNING_KEY),
        body.challenge,
        "enroll",
        now,
      );
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
        // 同じ鍵が、有効でないアカウント (止めた、消した) のものだった。
        throw new ProblemError(403, "Forbidden", "The installation key cannot be enrolled.");
      }
      throw error;
    }
  });

  app.openapi(sessionRoute, async (c) => {
    const body = c.req.valid("json");
    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    try {
      challenge = await verifyChallenge(
        await loadChallengeKey(c.env.CHALLENGE_SIGNING_KEY),
        body.challenge,
        "session",
        now,
      );
    } catch (error) {
      if (error instanceof InvalidChallengeError)
        throw new ProblemError(401, "Unauthorized", "The challenge is invalid.");
      throw error;
    }
    const db = createDb(c.env.DB);
    const installation = await findActiveInstallation(db, body.installation_id);
    // インストールがないときと、署名が違うときは、同じ応答にする (インストールの ID があるかを探られないため)。
    const verified =
      installation !== undefined &&
      (await verifyInstallationSignature(
        parseInstallationPublicKeyOrEmpty(installation.publicKey),
        sessionMessage(body.challenge, body.installation_id),
        body.signature,
      ));
    if (installation === undefined || !verified)
      throw new ProblemError(401, "Unauthorized", "The credentials are invalid.");

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
