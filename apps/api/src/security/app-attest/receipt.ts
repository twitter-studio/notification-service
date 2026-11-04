import * as asn1 from "asn1js";
import { type Certificate, ContentInfo, SignedData } from "pkijs";
import { certificate, engine, publicPoint } from "./certificates";
import { equal, parseAsn1, requireValid, text } from "./data";

export async function verifyReceipt(input: {
  receipt: Uint8Array;
  appId: string;
  point: Uint8Array;
  root: Certificate;
  now: Date;
}) {
  requireValid(input.receipt.length > 0 && input.receipt.length <= 65536);
  const content = new ContentInfo({ schema: parseAsn1(input.receipt) });
  requireValid(content.contentType === "1.2.840.113549.1.7.2");
  const signed = new SignedData({ schema: content.content });
  requireValid(
    signed.signerInfos.length === 1 &&
      signed.signerInfos[0]?.signatureAlgorithm.algorithmId === "1.2.840.10045.4.3.2" &&
      signed.digestAlgorithms.length === 1 &&
      signed.digestAlgorithms[0]?.algorithmId === "2.16.840.1.101.3.4.2.1",
  );
  requireValid(signed.encapContentInfo.eContentType === "1.2.840.113549.1.7.1");
  const verification = await signed.verify(
    {
      signer: 0,
      trustedCerts: [input.root],
      checkDate: input.now,
      checkChain: true,
      extendedMode: true,
      passedWhenNotRevValues: true,
    },
    engine(),
  );
  requireValid(
    verification.signatureVerified === true && verification.signerCertificateVerified === true,
  );
  const signer = verification.signerCertificate;
  requireValid(
    signer?.extensions?.some((extension) => extension.extnID === "1.2.840.113635.100.12.15"),
  );
  const payload = signed.encapContentInfo.eContent;
  requireValid(payload instanceof asn1.OctetString);
  const attributes = parseAsn1(new Uint8Array(payload.getValue()));
  requireValid(attributes instanceof asn1.Set && attributes.valueBlock.value.length <= 32);
  const values = new Map<number, Uint8Array>();
  for (const attribute of attributes.valueBlock.value) {
    requireValid(attribute instanceof asn1.Sequence && attribute.valueBlock.value.length === 3);
    const [type, version, value] = attribute.valueBlock.value;
    requireValid(
      type instanceof asn1.Integer &&
        version instanceof asn1.Integer &&
        version.valueBlock.valueDec === 1 &&
        value instanceof asn1.OctetString,
    );
    const id = type.valueBlock.valueDec;
    requireValid(Number.isSafeInteger(id) && !values.has(id));
    values.set(id, new Uint8Array(value.getValue()));
  }
  const app = values.get(2),
    key = values.get(3),
    kind = values.get(6),
    creation = values.get(12);
  requireValid(
    app !== undefined && key !== undefined && kind !== undefined && creation !== undefined,
  );
  requireValid(text(app) === input.appId && text(kind) === "ATTEST");
  const timestamp = text(creation);
  requireValid(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp));
  const createdAt = Date.parse(timestamp);
  requireValid(
    Number.isFinite(createdAt) &&
      input.now.getTime() - createdAt <= 300000 &&
      createdAt <= input.now.getTime() + 60000,
  );
  requireValid(equal(publicPoint(certificate(key)), input.point));
}
