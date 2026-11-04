import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  consumeDailyRelayQuota,
  createDb,
  deleteAccountFromInstallation,
  findActiveInstallation,
  findCurrentRelayCredential,
  findInstallationDevice,
  invalidateDevice,
  isUniqueViolation,
  listActiveDevices,
} from "@notification-service/db";
import type { AppEnv } from "../app";
import { requireSession } from "../middleware/session";
import { eventKeyOf } from "../notifications/payload";
import type { PushGateway } from "../notifications/push";
import { ProblemError } from "../problem";
import { challengeKeyFromEnv, InvalidChallengeError, verifyChallenge } from "../security/challenge";
import { loadDeviceTokenKeys, openDeviceToken } from "../security/device-token";
import {
  deleteAccountMessage,
  parseInstallationPublicKey,
  verifyInstallationSignature,
} from "../security/installation-key";
import { enforceRateLimit } from "../security/rate-limit";
import { deviceFields } from "./devices";
import { MAX_EVENTS_PER_DAY } from "./notifications";
import {
  commonProblems,
  InstallationProofSchema,
  problemResponse,
  retryableProblemResponse,
  sessionProblems,
  signedSessionProblems,
} from "./openapi";

const settingsRoute = createRoute({
  method: "get",
  path: "/v1/settings",
  operationId: "getNotificationSettings",
  middleware: [requireSession] as const,
  security: [{ session: [] }],
  summary: "自分のインストールの通知状態と、中継の資格情報の公開メタデータを返す",
  responses: {
    200: {
      description: "通知の設定 (秘密は含めない)",
      content: {
        "application/json": {
          schema: z
            .object({
              device: z.object(deviceFields).nullable(),
              relay_credential: z
                .object({ id: z.string(), expires_at: z.string().nullable() })
                .nullable(),
            })
            .openapi("NotificationSettings"),
        },
      },
    },
    ...sessionProblems,
    ...commonProblems,
  },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/account",
  operationId: "deleteNotificationAccount",
  middleware: [requireSession] as const,
  security: [{ session: [] }],
  summary: "自分の通知アカウントの秘密と端末情報を削除する。削除専用の新しい署名を求める",
  request: {
    body: { required: true, content: { "application/json": { schema: InstallationProofSchema } } },
  },
  responses: {
    204: { description: "削除した。セッションと中継の資格情報はもう使えない" },
    ...signedSessionProblems,
    409: problemResponse("チャレンジはもう使われた"),
    ...commonProblems,
  },
});
const testRoute = createRoute({
  method: "post",
  path: "/v1/notifications/test",
  operationId: "sendTestNotification",
  middleware: [requireSession] as const,
  security: [{ session: [] }],
  summary: "自分の確認済みで通知が有効なインストールに、固定のテスト通知を送る",
  responses: {
    200: {
      description: "APNs への送信または再送の予約 (画面に届いた証明ではない)",
      content: {
        "application/json": {
          schema: z
            .object({ status: z.enum(["sent", "queued"]) })
            .openapi("TestNotificationResult"),
        },
      },
    },
    ...sessionProblems,
    409: problemResponse("端末がない、未確認、または通知が停止・無効"),
    503: retryableProblemResponse("送れなかった"),
    ...commonProblems,
  },
});

export function registerSettings(app: OpenAPIHono<AppEnv>, push: PushGateway) {
  app.openapi(settingsRoute, async (c) => {
    const session = c.get("session");
    const db = createDb(c.env.DB);
    const [device, credential] = await Promise.all([
      findInstallationDevice(db, session),
      findCurrentRelayCredential(db, session.accountId),
    ]);
    return c.json(
      {
        device:
          device === undefined
            ? null
            : { device_id: device.id, state: device.state, verified: device.verified },
        relay_credential:
          credential === undefined
            ? null
            : { id: credential.id, expires_at: credential.expiresAt?.toISOString() ?? null },
      },
      200,
    );
  });
  app.openapi(deleteRoute, async (c) => {
    const session = c.get("session");
    const body = c.req.valid("json");
    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    try {
      challenge = await verifyChallenge(
        await challengeKeyFromEnv(c.env),
        body.challenge,
        "delete_account",
        now,
      );
    } catch (error) {
      if (error instanceof InvalidChallengeError)
        throw new ProblemError(401, "Unauthorized", "The challenge is invalid.");
      throw error;
    }
    const db = createDb(c.env.DB);
    const installation = await findActiveInstallation(db, session.installationId);
    if (
      installation === undefined ||
      installation.accountId !== session.accountId ||
      !(await verifyInstallationSignature(
        parseInstallationPublicKey(installation.publicKey),
        deleteAccountMessage(body.challenge, session.installationId),
        body.signature,
      ))
    )
      throw new ProblemError(401, "Unauthorized", "The signature is invalid.");
    await enforceRateLimit(
      c.env.INSTALLATION_RATE_LIMITER,
      `account-delete:${session.installationId}`,
    );
    try {
      if (!(await deleteAccountFromInstallation(db, { ...session, challenge }, now)))
        throw new ProblemError(401, "Unauthorized", "The installation is not active.");
    } catch (error) {
      if (isUniqueViolation(error, "used_challenges.nonce"))
        throw new ProblemError(409, "Conflict", "The challenge has already been used.");
      throw error;
    }
    return c.body(null, 204);
  });
  app.openapi(testRoute, async (c) => {
    const session = c.get("session");
    await enforceRateLimit(
      c.env.INSTALLATION_RATE_LIMITER,
      `test-notification:${session.installationId}`,
    );
    const db = createDb(c.env.DB);
    const now = new Date();
    const device = (await listActiveDevices(db, session.accountId)).find(
      (d) => d.installationId === session.installationId,
    );
    if (device === undefined) throw new ProblemError(409, "Conflict", "The device is not ready.");
    if (
      !(await consumeDailyRelayQuota(
        db,
        { accountId: session.accountId, limit: MAX_EVENTS_PER_DAY },
        now,
      ))
    ) {
      const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      throw new ProblemError(429, "Too Many Requests", undefined, {
        "Retry-After": String(Math.ceil((tomorrow - now.getTime()) / 1000)),
      });
    }
    const keys = await loadDeviceTokenKeys(c.env);
    const apnsToken = await openDeviceToken(keys, {
      ciphertext: device.apnsTokenCiphertext,
      fingerprint: device.tokenFingerprint,
      installationId: device.installationId,
      apnsEnvironment: device.apnsEnvironment,
      topic: device.topic,
    });
    const outcome = await push(
      {
        accountId: session.accountId,
        authority: { kind: "installation", installationId: session.installationId },
        deviceId: device.id,
        tokenFingerprint: device.tokenFingerprint,
        registrationCiphertext: device.apnsTokenCiphertext,
        apnsToken,
        apnsEnvironment: device.apnsEnvironment,
        topic: device.topic,
      },
      {
        eventKey: await eventKeyOf(keys, session.accountId, crypto.randomUUID()),
        payload: {
          aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
          event_type: "test",
        },
      },
      { signal: AbortSignal.timeout(10_000) },
    ).catch(() => {
      throw new ProblemError(503, "Service Unavailable", undefined, { "Retry-After": "60" });
    });
    if (outcome.kind === "sent" || outcome.kind === "queued")
      return c.json({ status: outcome.kind }, 200);
    if (outcome.kind === "invalid_token")
      await invalidateDevice(db, {
        deviceId: device.id,
        tokenFingerprint: device.tokenFingerprint,
        registrationCiphertext: device.apnsTokenCiphertext,
        invalidatedBefore: new Date(outcome.invalidatedBefore),
        apnsEnvironment: device.apnsEnvironment,
        topic: device.topic,
      });
    throw new ProblemError(503, "Service Unavailable", undefined, { "Retry-After": "60" });
  });
}
