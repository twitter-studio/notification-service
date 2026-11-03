import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createDb,
  findActiveInstallation,
  isUniqueViolation,
  revokeRelayCredential,
  rotateRelayCredential,
} from "@notification-service/db";
import type { AppEnv } from "../app";
import { requireSession } from "../middleware/session";
import { ProblemError } from "../problem";
import { hashBearerToken, newBearerToken } from "../security/bearer";
import { challengeKeyFromEnv, InvalidChallengeError, verifyChallenge } from "../security/challenge";
import {
  parseInstallationPublicKey,
  relayCredentialMessage,
  verifyInstallationSignature,
} from "../security/installation-key";
import { enforceRateLimit } from "../security/rate-limit";
import {
  commonProblems,
  InstallationProofSchema,
  problemResponse,
  sessionProblems,
} from "./openapi";

// 中継の資格情報の入れ替えと取り消し (設計書 §4、AUTH-002、ADR-0007)。

const rotateRoute = createRoute({
  method: "post",
  path: "/v1/relay-credentials/rotate",
  middleware: [requireSession] as const,
  summary: "中継の資格情報を入れ替える。前のものはすべて取り消し、新しい秘密をこの応答でだけ返す",
  request: {
    body: { required: true, content: { "application/json": { schema: InstallationProofSchema } } },
  },
  responses: {
    201: {
      description: "新しい中継の資格情報",
      content: {
        "application/json": {
          schema: z
            .object({ relay_credential_id: z.string(), relay_secret: z.string() })
            .openapi("RelayCredential"),
        },
      },
    },
    ...sessionProblems,
    409: problemResponse("チャレンジはもう使われた"),
    ...commonProblems,
  },
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/v1/relay-credentials/{id}",
  middleware: [requireSession] as const,
  summary: "中継の資格情報を取り消す",
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "取り消した" },
    ...sessionProblems,
    404: problemResponse("このアカウントの使える資格情報にない"),
    ...commonProblems,
  },
});

export function registerRelayCredentials(app: OpenAPIHono<AppEnv>) {
  app.openapi(rotateRoute, async (c) => {
    const session = c.get("session");
    const body = c.req.valid("json");
    const now = new Date();
    let challenge: { nonce: string; expiresAt: Date };
    try {
      challenge = await verifyChallenge(
        await challengeKeyFromEnv(c.env),
        body.challenge,
        "relay_credential",
        now,
      );
    } catch (error) {
      if (error instanceof InvalidChallengeError)
        throw new ProblemError(401, "Unauthorized", "The challenge is invalid.");
      throw error;
    }
    const db = createDb(c.env.DB);
    const installation = await findActiveInstallation(db, session.installationId);
    const verified =
      installation !== undefined &&
      installation.accountId === session.accountId &&
      (await verifyInstallationSignature(
        parseInstallationPublicKey(installation.publicKey),
        relayCredentialMessage(body.challenge, session.installationId),
        body.signature,
      ));
    if (!verified) throw new ProblemError(401, "Unauthorized", "The signature is invalid.");
    await enforceRateLimit(
      c.env.INSTALLATION_RATE_LIMITER,
      `relay-credential:${session.installationId}`,
    );

    const relaySecret = newBearerToken("relay");
    let credentialId: string | undefined;
    try {
      credentialId = await rotateRelayCredential(
        db,
        {
          accountId: session.accountId,
          installationId: session.installationId,
          challenge,
          secretHash: await hashBearerToken(relaySecret),
        },
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error, "used_challenges.nonce"))
        throw new ProblemError(409, "Conflict", "The challenge has already been used.");
      throw error;
    }
    if (credentialId === undefined)
      throw new ProblemError(401, "Unauthorized", "The installation is not active.");
    return c.json({ relay_credential_id: credentialId, relay_secret: relaySecret }, 201);
  });

  app.openapi(revokeRoute, async (c) => {
    const session = c.get("session");
    const { id } = c.req.valid("param");
    await enforceRateLimit(
      c.env.INSTALLATION_RATE_LIMITER,
      `relay-credential:${session.installationId}`,
    );
    const revoked = await revokeRelayCredential(createDb(c.env.DB), {
      accountId: session.accountId,
      credentialId: id,
    });
    if (!revoked) throw new ProblemError(404, "Not Found");
    return c.body(null, 204);
  });
}
