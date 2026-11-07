import { z } from "@hono/zod-openapi";
import type { NewAttestation, SessionAttestation } from "@notification-service/db";
import { ProblemError } from "../../problem";
import { DeviceTokenKeyError, type DeviceTokenKeys, loadDeviceTokenKeys } from "../device-token";
import { fromBase64Url, toBase64Url } from "../encoding";
import { buffer, concatenate, requireValid } from "./data";
import type { appleAppAttest } from "./verifier";

const Policy = z
  .object({
    mode: z.enum(["invite_only", "required", "required_with_invite"]),
    appId: z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/),
    environment: z.enum(["development", "production"]),
  })
  .strict();
export function appAttestPolicy(env: { APP_ATTEST_POLICY: string }) {
  try {
    return Policy.parse(JSON.parse(env.APP_ATTEST_POLICY));
  } catch {
    throw new Error("invalid_app_attest_policy");
  }
}
export const AppAttestProof = z
  .object({
    kind: z.enum(["attestation", "assertion"]),
    key_id: z.string().length(43),
    data: z.string().min(1).max(87382),
  })
  .strict()
  .openapi("AppAttestProof");

export type AppAttestVerifier = typeof appleAppAttest;
export async function registrationProof(input: {
  proof: z.infer<typeof AppAttestProof> | undefined;
  existing: NewAttestation | null | undefined;
  clientData: string;
  env: Env;
  now: Date;
  verifier: AppAttestVerifier;
}): Promise<SessionAttestation> {
  const policy = appAttestPolicy(input.env);
  if (input.proof === undefined) {
    if (input.existing != null || policy.mode !== "invite_only") throw unauthorized();
    return { kind: "none" };
  }
  try {
    const keyId = fromBase64Url(input.proof.key_id);
    const object = fromBase64Url(input.proof.data);
    requireValid(keyId?.length === 32 && object !== undefined);
    const clientData = new TextEncoder().encode(input.clientData);
    if (input.proof.kind === "attestation") {
      requireValid(input.existing == null || input.existing.keyId !== input.proof.key_id);
      const verified = await input.verifier.attestation({
        object,
        keyId,
        clientData,
        policy,
        now: input.now,
      });
      const keys = await loadDeviceTokenKeys(input.env);
      return {
        kind: "initial",
        ...(input.existing == null ? {} : { previousKeyId: input.existing.keyId }),
        value: {
          keyId: input.proof.key_id,
          publicKey: toBase64Url(verified.publicKey),
          counter: 0,
          appId: policy.appId,
          environment: policy.environment,
          receiptCiphertext: await sealReceipt(keys, verified.receipt, input.proof.key_id),
        },
      };
    }
    const existing = input.existing;
    if (existing == null || existing.keyId !== input.proof.key_id)
      throw new ProblemError(428, "Precondition Required", "An attestation is required.");
    requireValid(
      existing != null &&
        existing.keyId === input.proof.key_id &&
        existing.appId === policy.appId &&
        existing.environment === policy.environment,
    );
    const publicKey = fromBase64Url(existing.publicKey);
    requireValid(publicKey !== undefined);
    const counter = await input.verifier.assertion({
      object,
      publicKey,
      previousCounter: existing.counter,
      clientData,
      policy,
    });
    return { kind: "assertion", keyId: existing.keyId, previousCounter: existing.counter, counter };
  } catch (error) {
    if (error instanceof ProblemError || error instanceof DeviceTokenKeyError) throw error;
    throw unauthorized();
  }
}
function unauthorized() {
  return new ProblemError(401, "Unauthorized", "The credentials are invalid.");
}

function receiptBinding(keyId: string, encryptionKeyId: string) {
  return new TextEncoder().encode(
    JSON.stringify(["twitter-studio/app-attest-receipt", "ar1", encryptionKeyId, keyId]),
  );
}
export async function sealReceipt(keys: DeviceTokenKeys, receipt: Uint8Array, keyId: string) {
  const key = keys.keys.get(keys.currentKeyId);
  if (key === undefined) throw new Error("invalid_receipt_key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: receiptBinding(keyId, keys.currentKeyId) },
    key,
    buffer(receipt),
  );
  return ["ar1", keys.currentKeyId, toBase64Url(concatenate(iv, new Uint8Array(encrypted)))].join(
    ".",
  );
}
