import { ProblemError } from "./problem";
import { appAttestPolicy } from "./security/app-attest/registration";

declare global {
  interface Env {
    PUBLIC_ENROLLMENT_ENABLED?: string;
    PUBLIC_DELIVERY_ENABLED?: string;
  }
}

export type RuntimeEnv = Omit<Env, "APP_ATTEST_POLICY"> & { APP_ATTEST_POLICY: string };

export function publicOperationEnabled(
  env: Pick<
    RuntimeEnv,
    "APP_ATTEST_POLICY" | "PUBLIC_ENROLLMENT_ENABLED" | "PUBLIC_DELIVERY_ENABLED"
  >,
  operation: "PUBLIC_ENROLLMENT_ENABLED" | "PUBLIC_DELIVERY_ENABLED",
): boolean {
  const policy = appAttestPolicy(env);
  return (
    policy.mode !== "required" || policy.environment !== "production" || env[operation] === "true"
  );
}

export function requireDeliveryEnabled(env: Env): void {
  if (!publicOperationEnabled(env, "PUBLIC_DELIVERY_ENABLED")) {
    throw new ProblemError(503, "Service Unavailable", undefined, { "Retry-After": "900" });
  }
}
