import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createDb,
  createDeviceVerification,
  deviceAwaitsVerification,
  disableDeviceByUser,
  enableDeviceByUser,
  findActiveInstallation,
  findInstallationDevice,
  isUniqueViolation,
  markDeviceVerified,
  registerDeviceToken,
} from "@notification-service/db";
import type { AppEnv } from "../app";
import type { DeviceVerificationSender } from "../devices/verification";
import { DEVICE_VERIFICATION_TTL_MS } from "../devices/verification";
import { requireSession } from "../middleware/session";
import { requireDeliveryEnabled } from "../operations";
import { ProblemError } from "../problem";
import { hashBearerToken, newBearerToken } from "../security/bearer";
import { challengeKeyFromEnv, InvalidChallengeError, verifyChallenge } from "../security/challenge";
import {
  InvalidDeviceTokenError,
  loadDeviceTokenKeys,
  normalizeDeviceToken,
  sealDeviceToken,
} from "../security/device-token";
import {
  deviceMessage,
  parseInstallationPublicKey,
  verifyInstallationSignature,
} from "../security/installation-key";
import { enforceRateLimit, isWithinRateLimit, rateLimitKeyOf } from "../security/rate-limit";
import {
  commonProblems,
  idSchema,
  problemResponse,
  retryableProblemResponse,
  sessionProblems,
  signedSessionProblems,
} from "./openapi";

// 端末 (APNs のトークン) の登録、入れ替え、止める、トークンを持っていることの確かめ (設計書 §4、API-002、ADR-0008)。
// v1 の端末はインストールごとに 1 つなので、`{id}` はインストールの ID。セッションのインストールのものだけを扱う。

/** 確かめの code の期限。 */

const ParamsSchema = z.object({ id: idSchema("インストールの ID") });

export const deviceFields = {
  device_id: z.string(),
  state: z.enum(["active", "disabled_by_user", "invalidated"]),
  /** トークンを持っていることを確かめたか。確かめるまで通知を送らない。 */
  verified: z.boolean(),
};

const DeviceSchema = z.object(deviceFields).openapi("Device");

const putRoute = createRoute({
  operationId: "putDevice",
  method: "put",
  path: "/v1/devices/{id}",
  middleware: [requireSession] as const,
  security: [{ session: [] }],
  summary:
    "端末の APNs のトークン、環境、topic を登録する (入れ替えも同じ)。確かめていなければ、確かめの push を送る",
  request: {
    params: ParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              apns_token: z.string().max(256),
              apns_environment: z.enum(["sandbox", "production"]),
              topic: z.string().max(255),
              /** true で通知を受け取る、false で止める。省くと今のまま (トークンの入れ替えで、止めた設定を戻さない)。 */
              enabled: z.boolean().optional(),
              challenge: z.string().max(512),
              signature: z.string().max(128),
            })
            .openapi("DeviceRegistration"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "登録した端末",
      content: {
        "application/json": {
          // Device を extend すると allOf になり、生成した Swift の型が 2 つに分かれるので、欄を並べ直す。
          schema: z
            .object({
              ...deviceFields,
              /** 確かめの push を送ったか (APNs へ送る仕組みがまだないときは false)。 */
              verification_sent: z.boolean(),
            })
            .openapi("DeviceRegistrationResult"),
        },
      },
    },
    ...signedSessionProblems,
    404: problemResponse("セッションのインストールでない"),
    409: problemResponse("チャレンジはもう使われた"),
    503: retryableProblemResponse("所有確認の送信を停止中"),
    ...commonProblems,
  },
});

const verifyRoute = createRoute({
  operationId: "verifyDevice",
  method: "post",
  path: "/v1/devices/{id}/verification",
  middleware: [requireSession] as const,
  security: [{ session: [] }],
  summary: "確かめの push で届いた code を返し、端末がトークンを持っていることを確かめる",
  request: {
    params: ParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ code: z.string().max(64) }).openapi("DeviceVerification"),
        },
      },
    },
  },
  responses: {
    200: { description: "確かめた", content: { "application/json": { schema: DeviceSchema } } },
    ...sessionProblems,
    404: problemResponse("セッションのインストールでない、または端末がない"),
    ...commonProblems,
  },
});

const disableRoute = createRoute({
  operationId: "disableDevice",
  method: "delete",
  path: "/v1/devices/{id}",
  middleware: [requireSession] as const,
  security: [{ session: [] }],
  summary: "端末への通知を止める",
  request: { params: ParamsSchema },
  responses: {
    204: { description: "止めた" },
    ...sessionProblems,
    404: problemResponse("セッションのインストールでない、または端末がない"),
    ...commonProblems,
  },
});

/** 送ってよい topic (Bundle ID) の一覧。設定 `APNS_TOPICS` (カンマ区切り)。 */
function allowedTopics(env: Env): ReadonlySet<string> {
  return new Set(
    env.APNS_TOPICS.split(",")
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0),
  );
}

export function registerDevices(
  app: OpenAPIHono<AppEnv>,
  sendVerification: DeviceVerificationSender,
) {
  app.openapi(putRoute, async (c) => {
    requireDeliveryEnabled(c.env);
    const session = c.get("session");
    const { id } = c.req.valid("param");
    // ほかのインストールの ID は、あるかを区別せずに 404 にする。
    if (id !== session.installationId) throw new ProblemError(404, "Not Found");
    const body = c.req.valid("json");
    if (!allowedTopics(c.env).has(body.topic))
      throw new ProblemError(422, "Unprocessable Content", "The topic is not allowed.");
    let apnsToken: string;
    try {
      apnsToken = normalizeDeviceToken(body.apns_token);
    } catch (error) {
      if (error instanceof InvalidDeviceTokenError)
        throw new ProblemError(422, "Unprocessable Content", "The APNs token is invalid.");
      throw error;
    }

    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    try {
      challenge = await verifyChallenge(
        await challengeKeyFromEnv(c.env),
        body.challenge,
        "device",
        now,
      );
    } catch (error) {
      if (error instanceof InvalidChallengeError)
        throw new ProblemError(401, "Unauthorized", "The challenge is invalid.");
      throw error;
    }
    const db = createDb(c.env.DB);
    const installation = await findActiveInstallation(db, session.installationId);
    const device = {
      apnsEnvironment: body.apns_environment,
      topic: body.topic,
      apnsToken,
      enabled: body.enabled,
    };
    const verified =
      installation !== undefined &&
      installation.accountId === session.accountId &&
      (await verifyInstallationSignature(
        parseInstallationPublicKey(installation.publicKey),
        deviceMessage(body.challenge, session.installationId, device),
        body.signature,
      ));
    if (!verified) throw new ProblemError(401, "Unauthorized", "The signature is invalid.");
    await enforceRateLimit(c.env.INSTALLATION_RATE_LIMITER, `device:${session.installationId}`);

    const keys = await loadDeviceTokenKeys(c.env);
    const sealed = await sealDeviceToken(keys, apnsToken, {
      installationId: session.installationId,
      apnsEnvironment: body.apns_environment,
      topic: body.topic,
    });
    let registration: Awaited<ReturnType<typeof registerDeviceToken>>;
    try {
      registration = await registerDeviceToken(
        db,
        {
          accountId: session.accountId,
          installationId: session.installationId,
          apnsTokenCiphertext: sealed.ciphertext,
          tokenFingerprint: sealed.fingerprint,
          apnsEnvironment: body.apns_environment,
          topic: body.topic,
          challenge,
        },
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error, "used_challenges.nonce"))
        throw new ProblemError(409, "Conflict", "The challenge has already been used.");
      throw error;
    }
    if (registration.kind === "rejected")
      throw new ProblemError(401, "Unauthorized", "The installation is not active.");
    const owner = { accountId: session.accountId, deviceId: registration.deviceId };
    if (body.enabled === true) await enableDeviceByUser(db, owner, now);
    if (body.enabled === false) await disableDeviceByUser(db, owner, now);

    // 確かめの push を送るのは、端末の行が今このトークンで、まだ確かめていないときだけ。
    // 確かめの push は、トークンを知っていればどのアカウントからでも送らせられるので、送るときだけトークンごとにも数える。
    // 超えたら送らず、登録は通す (ほかの人に、持ち主の登録を 429 にさせない)。届いている code の記録も置き換えない。
    const target = {
      ...owner,
      tokenFingerprint: sealed.fingerprint,
      apnsEnvironment: body.apns_environment,
      topic: body.topic,
    };
    const code = newBearerToken("verification");
    const verificationSent =
      (await deviceAwaitsVerification(db, target)) &&
      (await isWithinRateLimit(
        c.env.TOKEN_RATE_LIMITER,
        `device-token:${await rateLimitKeyOf(sealed.fingerprint)}`,
      )) &&
      // 記録は push を送るトークン (この要求の値) で置く。間に行がほかのトークンに変わっていたら置かず、送らない。
      (await createDeviceVerification(
        db,
        {
          ...target,
          codeHash: await hashBearerToken(code),
          expiresAt: new Date(now.getTime() + DEVICE_VERIFICATION_TTL_MS),
        },
        now,
      )) &&
      (await sendVerification({
        deviceId: registration.deviceId,
        tokenFingerprint: sealed.fingerprint,
        registrationCiphertext: sealed.ciphertext,
        apnsToken,
        apnsEnvironment: body.apns_environment,
        topic: body.topic,
        code,
      }));

    const current = await findInstallationDevice(db, session);
    if (current === undefined)
      throw new ProblemError(401, "Unauthorized", "The installation is not active.");
    return c.json(
      {
        device_id: current.id,
        state: current.state,
        verified: current.verified,
        verification_sent: verificationSent,
      },
      200,
    );
  });

  app.openapi(verifyRoute, async (c) => {
    const session = c.get("session");
    const { id } = c.req.valid("param");
    if (id !== session.installationId) throw new ProblemError(404, "Not Found");
    const { code } = c.req.valid("json");
    // セッションごとに数える。漏れたセッションで違う code を送り続けても、持ち主のほかのセッションの確かめを止めさせない。
    await enforceRateLimit(
      c.env.INSTALLATION_RATE_LIMITER,
      `device-verification:${session.sessionId}`,
    );
    const db = createDb(c.env.DB);
    const device = await findInstallationDevice(db, session);
    if (device === undefined) throw new ProblemError(404, "Not Found");
    const confirmed = await markDeviceVerified(db, {
      accountId: session.accountId,
      deviceId: device.id,
      codeHash: await hashBearerToken(code),
    });
    if (!confirmed)
      throw new ProblemError(422, "Unprocessable Content", "The verification code is invalid.");
    return c.json({ device_id: device.id, state: device.state, verified: true }, 200);
  });

  app.openapi(disableRoute, async (c) => {
    const session = c.get("session");
    const { id } = c.req.valid("param");
    if (id !== session.installationId) throw new ProblemError(404, "Not Found");
    await enforceRateLimit(
      c.env.INSTALLATION_RATE_LIMITER,
      `device-disable:${session.installationId}`,
    );
    const db = createDb(c.env.DB);
    const device = await findInstallationDevice(db, session);
    if (
      device === undefined ||
      !(await disableDeviceByUser(db, { accountId: session.accountId, deviceId: device.id }))
    )
      throw new ProblemError(404, "Not Found");
    return c.body(null, 204);
  });
}
