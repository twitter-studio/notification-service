import * as asn1 from "asn1js";
import { Certificate, CertificateChainValidationEngine, CryptoEngine } from "pkijs";
import { equal, parseAsn1, requireValid } from "./data";

class WorkersCryptoEngine extends CryptoEngine {
  timingSafeEqual(...args: Parameters<SubtleCrypto["timingSafeEqual"]>) {
    return crypto.subtle.timingSafeEqual(...args);
  }
}
export function engine() {
  return new WorkersCryptoEngine({ name: "Workers WebCrypto", crypto });
}
export function certificate(input: Uint8Array) {
  return new Certificate({ schema: parseAsn1(input) });
}
export function publicPoint(cert: Certificate) {
  requireValid(cert.subjectPublicKeyInfo.algorithm.algorithmId === "1.2.840.10045.2.1");
  const curve = cert.subjectPublicKeyInfo.algorithm.algorithmParams;
  requireValid(
    curve instanceof asn1.ObjectIdentifier && curve.valueBlock.toString() === "1.2.840.10045.3.1.7",
  );
  const point = new Uint8Array(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView);
  requireValid(point.length === 65 && point[0] === 4);
  return point;
}
export async function verifyChain(chain: Certificate[], root: Certificate, now: Date) {
  requireValid(chain.length === 2);
  const leaf = chain[0],
    intermediate = chain[1];
  requireValid(leaf !== undefined && intermediate !== undefined);
  const result = await new CertificateChainValidationEngine({
    trustedCerts: [root],
    certs: [intermediate, leaf],
    checkDate: now,
  }).verify({ passedWhenNotRevValues: true }, engine());
  const path = result.certificatePath;
  requireValid(result.result && path?.length === 3);
  requireValid(
    path[0] !== undefined &&
      equal(
        new Uint8Array(path[0].toSchema(true).toBER()),
        new Uint8Array(leaf.toSchema(true).toBER()),
      ),
  );
  const anchor = path.at(-1);
  requireValid(
    anchor !== undefined &&
      equal(
        new Uint8Array(anchor.toSchema(true).toBER()),
        new Uint8Array(root.toSchema(true).toBER()),
      ),
  );
}
export function nonceExtension(cert: Certificate) {
  const extensions = cert.extensions?.filter(
    (extension) => extension.extnID === "1.2.840.113635.100.8.2",
  );
  requireValid(extensions?.length === 1);
  const extension = extensions[0];
  requireValid(extension !== undefined);
  const sequence = parseAsn1(new Uint8Array(extension.extnValue.getValue()));
  requireValid(sequence instanceof asn1.Sequence && sequence.valueBlock.value.length === 1);
  const context = sequence.valueBlock.value[0];
  requireValid(
    context instanceof asn1.Constructed &&
      context.idBlock.tagClass === 3 &&
      context.idBlock.tagNumber === 1 &&
      context.valueBlock.value.length === 1,
  );
  const nonce = context.valueBlock.value[0];
  requireValid(nonce instanceof asn1.OctetString && !nonce.idBlock.isConstructed);
  const result = new Uint8Array(nonce.getValue());
  requireValid(result.length === 32);
  return result;
}
