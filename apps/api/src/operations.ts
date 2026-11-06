import { z } from "zod";
import { ProblemError } from "./problem";
import { appAttestPolicy } from "./security/app-attest/registration";
import { constantTimeEquals, hashBearerToken } from "./security/bearer";

declare global {
  interface Env {
    PUBLIC_ENROLLMENT_ENABLED?: string;
    PUBLIC_DELIVERY_ENABLED?: string;
    PUBLIC_TRIAL?: string;
  }
}

export type RuntimeEnv = Omit<Env, "APP_ATTEST_POLICY"> & { APP_ATTEST_POLICY: string };
type OperationsEnv = Pick<
  RuntimeEnv,
  "APP_ATTEST_POLICY" | "PUBLIC_ENROLLMENT_ENABLED" | "PUBLIC_DELIVERY_ENABLED" | "PUBLIC_TRIAL"
>;

const tokenShape = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const Trial = z.union([
  z.strictObject({ until: z.int().positive(), inviteHash: z.string().regex(tokenShape) }),
  z.strictObject({ until: z.int().positive(), resume: z.literal(true) }),
]);

function publicTrial(env: OperationsEnv) {
  if (env.PUBLIC_TRIAL === undefined) return;
  try {
    return Trial.parse(JSON.parse(env.PUBLIC_TRIAL));
  } catch {
    return undefined;
  }
}

function activeTrial(env: OperationsEnv) {
  const trial = publicTrial(env);
  return trial !== undefined && trial.until > Date.now() ? trial : undefined;
}

export function publicOperationEnabled(
  env: OperationsEnv,
  operation: "PUBLIC_ENROLLMENT_ENABLED" | "PUBLIC_DELIVERY_ENABLED",
): boolean {
  const policy = appAttestPolicy(env);
  return (
    policy.mode !== "required" ||
    policy.environment !== "production" ||
    (env.PUBLIC_TRIAL === undefined
      ? env[operation] === "true"
      : operation === "PUBLIC_DELIVERY_ENABLED" && activeTrial(env) !== undefined)
  );
}

type EnrollmentPermission =
  | { kind: "standard" }
  | { kind: "trial"; claim: { nonce: string; expiresAt: Date } };

export async function enrollmentPermission(
  env: OperationsEnv,
  inviteCode: string,
): Promise<EnrollmentPermission | undefined> {
  if (publicOperationEnabled(env, "PUBLIC_ENROLLMENT_ENABLED")) return { kind: "standard" };
  const trial = activeTrial(env);
  if (
    trial !== undefined &&
    "inviteHash" in trial &&
    tokenShape.test(inviteCode) &&
    (await constantTimeEquals(await hashBearerToken(inviteCode), trial.inviteHash)) &&
    trial.until > Date.now()
  ) {
    return {
      kind: "trial",
      claim: { nonce: `public-trial.${trial.inviteHash}`, expiresAt: new Date(trial.until) },
    };
  }
}

export function requireDeliveryEnabled(env: OperationsEnv, source?: "relay"): void {
  if (
    !publicOperationEnabled(env, "PUBLIC_DELIVERY_ENABLED") ||
    (source === "relay" && isPublicTrialResume(env))
  ) {
    throw new ProblemError(503, "Service Unavailable", undefined, { "Retry-After": "900" });
  }
}

export function isPublicTrialResume(env: OperationsEnv): boolean {
  const trial = publicTrial(env);
  return trial !== undefined && "resume" in trial;
}
