import * as asn1 from "asn1js";
import { decode, decodeFirst } from "cborg";
import { z } from "zod";

export class InvalidAppAttest extends Error {
  constructor() {
    super("invalid_app_attest");
  }
}
export const bytes = z.instanceof(Uint8Array).transform((value) => new Uint8Array(value));
const options = {
  strict: true,
  strictUtf8: true,
  useMaps: true,
  rejectDuplicateMapKeys: true,
  allowIndefinite: false,
  allowUndefined: false,
  allowInfinity: false,
  allowNaN: false,
  allowBigInt: false,
};
export function cbor(input: Uint8Array): unknown {
  return decode(input, options);
}
export function firstCbor(input: Uint8Array): [unknown, Uint8Array] {
  return decodeFirst(input, options);
}
export function buffer(input: Uint8Array): ArrayBuffer {
  return new Uint8Array(input).buffer;
}
export function concatenate(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export async function sha256(value: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(value)));
}
export function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
export function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new InvalidAppAttest();
}
export function parseAsn1(input: Uint8Array) {
  const parsed = asn1.fromBER(buffer(input));
  requireValid(parsed.offset === input.length && parsed.result.error.length === 0);
  return parsed.result;
}
export function text(input: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input);
}
