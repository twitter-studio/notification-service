import * as asn1 from "asn1js";
import type { Certificate } from "pkijs";
import { z } from "zod";
import { type AppAttestPolicy, authenticator } from "./authenticator";
import { certificate, nonceExtension, publicPoint, verifyChain } from "./certificates";
import {
  buffer,
  bytes,
  cbor,
  concatenate,
  equal,
  InvalidAppAttest,
  parseAsn1,
  requireValid,
  sha256,
} from "./data";
import { verifyReceipt } from "./receipt";
import { ATTESTATION_ROOT_PEM, RECEIPT_ROOT_BASE64 } from "./roots";

const Attestation = z.map(z.string(), z.unknown());
export type VerifiedAttestation = {
  keyId: Uint8Array<ArrayBuffer>;
  publicKey: Uint8Array<ArrayBuffer>;
  receipt: Uint8Array<ArrayBuffer>;
  counter: 0;
};
export function createAppAttestVerifier(anchors: {
  attestation: Certificate;
  receipt: Certificate;
}) {
  return {
    async attestation(input: {
      object: Uint8Array;
      keyId: Uint8Array;
      clientData: Uint8Array;
      policy: AppAttestPolicy;
      now: Date;
    }): Promise<VerifiedAttestation> {
      try {
        requireValid(input.object.length <= 65536 && input.keyId.length === 32);
        const value = Attestation.parse(cbor(input.object));
        requireValid(value.size === 3 && value.get("fmt") === "apple-appattest");
        const statement = Attestation.parse(value.get("attStmt"));
        requireValid(statement.size === 2);
        const encoded = z.array(bytes).length(2).parse(statement.get("x5c"));
        const receipt = bytes.parse(statement.get("receipt"));
        const authData = bytes.parse(value.get("authData"));
        const credential = await authenticator(authData, input.policy, "attestation");
        requireValid(credential.kind === "attestation");
        const chain = encoded.map(certificate);
        await verifyChain(chain, anchors.attestation, input.now);
        const leaf = chain[0];
        requireValid(leaf !== undefined);
        const point = publicPoint(leaf);
        requireValid(
          equal(point, credential.point) &&
            equal(await sha256(point), input.keyId) &&
            equal(credential.keyId, input.keyId),
        );
        const clientHash = await sha256(input.clientData);
        requireValid(equal(nonceExtension(leaf), await sha256(concatenate(authData, clientHash))));
        await verifyReceipt({
          receipt,
          point,
          appId: input.policy.appId,
          root: anchors.receipt,
          now: input.now,
        });
        return { keyId: new Uint8Array(input.keyId), publicKey: point, receipt, counter: 0 };
      } catch {
        throw new InvalidAppAttest();
      }
    },
    async assertion(input: {
      object: Uint8Array;
      publicKey: Uint8Array;
      previousCounter: number;
      clientData: Uint8Array;
      policy: AppAttestPolicy;
    }): Promise<number> {
      try {
        requireValid(input.object.length <= 8192);
        const map = Attestation.parse(cbor(input.object));
        requireValid(map.size === 2);
        const authData = bytes.parse(map.get("authenticatorData"));
        const signature = bytes.parse(map.get("signature"));
        const parsed = await authenticator(authData, input.policy, "assertion");
        requireValid(parsed.counter > input.previousCounter);
        const der = parseAsn1(signature);
        requireValid(
          der instanceof asn1.Sequence &&
            !der.lenBlock.isIndefiniteForm &&
            der.valueBlock.value.length === 2,
        );
        const raw = new Uint8Array(64);
        for (const [index, number] of der.valueBlock.value.entries()) {
          requireValid(number instanceof asn1.Integer);
          const original = new Uint8Array(number.valueBlock.valueHexView);
          requireValid(original.length > 0 && original.length <= 33 && (original[0] ?? 128) < 128);
          const unsigned = original[0] === 0 ? original.slice(1) : original;
          requireValid(
            unsigned.length <= 32 &&
              (original.length === 1 || original[0] !== 0 || (original[1] ?? 0) >= 128),
          );
          raw.set(unsigned, index * 32 + 32 - unsigned.length);
        }
        const key = await crypto.subtle.importKey(
          "raw",
          buffer(input.publicKey),
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        // WebCryptoがSHA-256を適用するため、二重にhashしたnonceではなく合成したバイト列を渡す。
        const signed = concatenate(authData, await sha256(input.clientData));
        requireValid(
          await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, buffer(signed)),
        );
        return parsed.counter;
      } catch {
        throw new InvalidAppAttest();
      }
    },
  };
}
function pem(input: string) {
  return new Uint8Array(
    Uint8Array.from(atob(input.replace(/-----[^-]+-----|\s/g, "")), (value) => value.charCodeAt(0)),
  );
}
export const appleAppAttest = createAppAttestVerifier({
  attestation: certificate(pem(ATTESTATION_ROOT_PEM)),
  receipt: certificate(Uint8Array.from(atob(RECEIPT_ROOT_BASE64), (value) => value.charCodeAt(0))),
});
