import { z } from "zod";
import { bytes, cbor, equal, firstCbor, requireValid, sha256 } from "./data";

export type AppAttestPolicy = {
  appId: string;
  environment: "development" | "production";
  bundleVersions: readonly string[];
};
function extensions(data: Uint8Array, policy: AppAttestPolicy) {
  const map = z.map(z.string(), z.unknown()).parse(cbor(data));
  const version = z.string().min(1).max(128).parse(map.get("apple_bundle_version_01"));
  const category = bytes.parse(map.get("apple_validation_category_01"));
  requireValid(category.length === 4 && policy.bundleVersions.includes(version));
  const value = new DataView(category.buffer).getUint32(0, true);
  requireValid(policy.environment === "development" ? value === 3 : value === 2 || value === 4);
}
export async function authenticator(
  data: Uint8Array,
  policy: AppAttestPolicy,
  kind: "attestation" | "assertion",
) {
  requireValid(data.length >= 37 && data.length <= 4096);
  requireValid(equal(data.slice(0, 32), await sha256(new TextEncoder().encode(policy.appId))));
  const flags = data[32];
  // Appleの公開例は拡張を含んでもED bitが0なので、拡張はflagsに頼らず必ず検証する (ADR-0014)。
  const allowedFlags = kind === "attestation" ? [0x40, 0xc0] : [0x00, 0x80];
  requireValid(flags !== undefined && allowedFlags.includes(flags));
  const counter = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(33, false);
  if (kind === "assertion") {
    requireValid(counter > 0);
    extensions(data.slice(37), policy);
    return { kind: "assertion", counter } as const;
  }
  requireValid(counter === 0 && data.length >= 87);
  const expectedAaguid =
    policy.environment === "development"
      ? new TextEncoder().encode("appattestdevelop")
      : new Uint8Array([...new TextEncoder().encode("appattest"), 0, 0, 0, 0, 0, 0, 0]);
  requireValid(equal(data.slice(37, 53), expectedAaguid));
  requireValid(
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(53, false) === 32,
  );
  const [value, rest] = firstCbor(data.slice(87));
  const key = z.map(z.number().int(), z.unknown()).parse(value);
  requireValid(key.size === 5 && key.get(1) === 2 && key.get(3) === -7 && key.get(-1) === 1);
  const x = bytes.parse(key.get(-2)),
    y = bytes.parse(key.get(-3));
  requireValid(x.length === 32 && y.length === 32);
  extensions(rest, policy);
  return {
    kind: "attestation",
    counter: 0,
    keyId: data.slice(55, 87),
    point: new Uint8Array([4, ...x, ...y]),
  } as const;
}
