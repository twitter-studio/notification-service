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
const Trial = z.strictObject({
  until: z.int().positive(),
  inviteHash: z.string().regex(tokenShape),
});

function activeTrial(env: OperationsEnv) {
  if (env.PUBLIC_TRIAL === undefined) return;
  try {
    const trial = Trial.parse(JSON.parse(env.PUBLIC_TRIAL));
    return trial.until > Date.now() ? trial : undefined;
  } catch {
    return undefined;
  }
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

export async function enrollmentEnabled(env: OperationsEnv, inviteCode: string): Promise<boolean> {
  if (publicOperationEnabled(env, "PUBLIC_ENROLLMENT_ENABLED")) return true;
  const trial = activeTrial(env);
  return (
    trial !== undefined &&
    tokenShape.test(inviteCode) &&
    (await constantTimeEquals(await hashBearerToken(inviteCode), trial.inviteHash)) &&
    trial.until > Date.now()
  );
}

export function requireDeliveryEnabled(env: OperationsEnv): void {
  if (!publicOperationEnabled(env, "PUBLIC_DELIVERY_ENABLED")) {
    throw new ProblemError(503, "Service Unavailable", undefined, { "Retry-After": "900" });
  }
}
