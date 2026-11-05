import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createDb,
  createSession,
  enrollInstallation,
  findActiveInstallation,
  findInstallationByPublicKey,
  isUniqueViolation,
} from "@notification-service/db";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { publicOperationEnabled } from "../operations";
import { ProblemError } from "../problem";
import {
  AppAttestProof,
  type AppAttestVerifier,
  appAttestPolicy,
  registrationProof,
} from "../security/app-attest/registration";
import { constantTimeEquals, hashBearerToken, newBearerToken } from "../security/bearer";
import {
  challengeKeyFromEnv,
  InvalidChallengeError,
  issueChallenge,
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
import { commonProblems, idSchema, problemResponse } from "./openapi";

// 端末の登録と、セッションの作り直し (設計書 §3 の手順 1〜3、ADR-0006)。

/** セッションの長さ。短くし、端末の鍵の署名で作り直す。 */
export const SESSION_TTL_MS = 60 * 60 * 1000;

const SessionSchema = z.object({ token: z.string(), expires_at: z.string() }).openapi("Session");

const challengeRoute = createRoute({
  method: "post",
  path: "/v1/enrollments/challenge",
  operationId: "issueChallenge",
  summary:
    "登録、セッションの作り直し、中継の資格情報の入れ替え、端末の登録で、端末の鍵に署名させるチャレンジを出す",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              purpose: z.enum([
                "enroll",
                "session",
                "relay_credential",
                "device",
                "delete_account",
              ]),
            })
            .openapi("ChallengeRequest"),
        },
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
  operationId: "enroll",
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
              invite_code: z.string().max(256).optional(),
              app_attest: AppAttestProof.optional(),
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
    428: problemResponse("このインストールには初回のApp Attestが必要"),
    409: problemResponse("チャレンジはもう使われた"),
    ...commonProblems,
  },
});

const sessionRoute = createRoute({
  method: "post",
  path: "/v1/sessions",
  operationId: "createSession",
  summary: "端末の鍵の署名で、セッションを作り直す",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              installation_id: idSchema("インストールの ID"),
              app_attest: AppAttestProof.optional(),
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
      content: {
        "application/json": {
          schema: z.object({ session: SessionSchema }).openapi("SessionResult"),
        },
      },
    },
    401: problemResponse("チャレンジ、インストール、署名のどれかが正しくない"),
    428: problemResponse("このインストールには初回のApp Attestが必要"),
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
async function checkInvite(
  c: Context<AppEnv>,
  inviteCode: string,
  warnings: { shortInviteCode: boolean },
): Promise<void> {
  const expected = c.env.ENROLLMENT_INVITE_CODE ?? "";
  const open = INVITE_CODE_SHAPE.test(expected);
  if (expected.length > 0 && !open && !warnings.shortInviteCode) {
    // 値は出さない。要求のたびに出すとログを埋められるので、アプリ (isolate) ごとに 1 回だけ出す。
    warnings.shortInviteCode = true;
    console.error(JSON.stringify({ event: "enrollment_invite_code_too_short" }));
  }
  // 受け付けていないときも比べ、かかる時間で秘密を置いたかを探らせない。
  const matches = await constantTimeEquals(inviteCode, expected);
  if (!open || !matches) throw new ProblemError(403, "Forbidden", "Enrollment is not available.");
}

export function registerEnrollment(app: OpenAPIHono<AppEnv>, verifier: AppAttestVerifier) {
  /** 設定の誤りのログを、もう出したか。アプリごとに持つ (本番では isolate ごとに 1 つのアプリ)。 */
  const warnings = { shortInviteCode: false };

  app.openapi(challengeRoute, async (c) => {
    await enforceRateLimit(c.env.CLIENT_RATE_LIMITER, clientAddressKey(c.req.raw));
    const { purpose } = c.req.valid("json");
    const issued = await issueChallenge(await challengeKeyFromEnv(c.env), purpose);
    return c.json({ challenge: issued.challenge, expires_at: issued.expiresAt.toISOString() }, 200);
  });

  app.openapi(enrollRoute, async (c) => {
    await enforceRateLimit(c.env.CLIENT_RATE_LIMITER, clientAddressKey(c.req.raw));
    const body = c.req.valid("json");
    if (!publicOperationEnabled(c.env, "PUBLIC_ENROLLMENT_ENABLED")) {
      throw new ProblemError(403, "Forbidden", "Enrollment is not available.");
    }
    if (appAttestPolicy(c.env).mode !== "required")
      await checkInvite(c, body.invite_code ?? "", warnings);

    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    let publicKey: Uint8Array<ArrayBuffer>;
    try {
      challenge = await verifyChallenge(
        await challengeKeyFromEnv(c.env),
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
    const existing = await findInstallationByPublicKey(db, body.public_key);
    const attestation = await registrationProof({
      proof: body.app_attest,
      existing: existing?.attestation,
      clientData: enrollmentMessage(body.challenge, body.public_key),
      env: c.env,
      now,
      verifier,
    });
    const relaySecret = newBearerToken("relay");
    const session = await newSession(now);
    try {
      const enrolled =
        existing?.accountId !== undefined
          ? { created: false as const, accountId: existing.accountId, installationId: existing.id }
          : await enrollInstallation(
              db,
              {
                publicKey: body.public_key,
                ...(attestation.kind === "initial" ? { attestation: attestation.value } : {}),
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
      // セッションの作り直しと同じく、インストールごとに数える (この入口で、制限を越えて作り直させない)。
      await enforceRateLimit(
        c.env.INSTALLATION_RATE_LIMITER,
        `installation:${enrolled.installationId}`,
      );
      const sessionId = await createSession(
        db,
        {
          accountId: enrolled.accountId,
          installationId: enrolled.installationId,
          attestation,
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
      if (isUniqueViolation(error, "installation_attestations.key_id"))
        throw new ProblemError(401, "Unauthorized", "The credentials are invalid.");
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
      challenge = await verifyChallenge(
        await challengeKeyFromEnv(c.env),
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

    const attestation = await registrationProof({
      proof: body.app_attest,
      existing: installation.attestation,
      clientData: sessionMessage(body.challenge, body.installation_id),
      env: c.env,
      now,
      verifier,
    });
    const session = await newSession(now);
    try {
      const sessionId = await createSession(
        db,
        {
          accountId: installation.accountId,
          installationId: body.installation_id,
          attestation,
          challenge,
          session: session.record,
        },
        now,
      );
      if (sessionId === undefined)
        throw new ProblemError(401, "Unauthorized", "The credentials are invalid.");
    } catch (error) {
      if (isUniqueViolation(error, "installation_attestations.key_id"))
        throw new ProblemError(401, "Unauthorized", "The credentials are invalid.");
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
