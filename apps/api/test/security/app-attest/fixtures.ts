import * as asn1 from "asn1js";
import { encode } from "cborg";
import {
  AttributeTypeAndValue,
  BasicConstraints,
  Certificate,
  ContentInfo,
  EncapsulatedContentInfo,
  Extension,
  IssuerAndSerialNumber,
  RelativeDistinguishedNames,
  SignedData,
  SignerInfo,
} from "pkijs";
import { engine } from "../../../src/security/app-attest/certificates";
import { concatenate, sha256 } from "../../../src/security/app-attest/data";
import { createAppAttestVerifier } from "../../../src/security/app-attest/verifier";

export const policy = {
  appId: "TESTTEAM01.com.example.attest",
  environment: "development",
} as const;
const name = (value: string) =>
  new RelativeDistinguishedNames({
    typesAndValues: [
      new AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1.Utf8String({ value }) }),
    ],
  });
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("P256 expected");
  return pair;
}
let serial = 1;
async function issue(
  now: Date,
  subject: string,
  pair: CryptoKeyPair,
  issuer: { cert: Certificate; keys: CryptoKeyPair } | undefined,
  ca: boolean,
  extra: Extension[] = [],
) {
  const cert = new Certificate({
    version: 2,
    serialNumber: new asn1.Integer({ value: serial++ }),
    subject: name(subject),
    issuer: issuer?.cert.subject ?? name(subject),
  });
  cert.notBefore.value = new Date(now.getTime() - 3600000);
  cert.notAfter.value = new Date(now.getTime() + 86400000);
  cert.extensions = [
    new Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: new BasicConstraints({ cA: ca }).toSchema().toBER(),
    }),
    new Extension({
      extnID: "2.5.29.15",
      critical: true,
      extnValue: new asn1.BitString({
        valueHex: new Uint8Array([ca ? 6 : 128]).buffer,
        unusedBits: ca ? 1 : 7,
      }).toBER(),
    }),
    ...extra,
  ];
  await cert.subjectPublicKeyInfo.importKey(pair.publicKey, engine());
  await cert.sign(issuer?.keys.privateKey ?? pair.privateKey, "SHA-256", engine());
  return { cert, keys: pair };
}
export async function fixture(
  options: {
    bundleVersion?: string;
    category?: number;
    clientData?: Uint8Array;
    environment?: "development" | "production";
    attestationFlags?: number;
    assertionFlags?: number;
    assertionSignatureInput?: "nonce" | "composite";
  } = {},
) {
  const now = new Date();
  const environment = options.environment ?? policy.environment;
  const attRoot = await issue(now, "Attest Root", await keys(), undefined, true);
  const intermediate = await issue(now, "Attest Intermediate", await keys(), attRoot, true);
  const receiptRoot = await issue(now, "Receipt Root", await keys(), undefined, true);
  const receiptSigner = await issue(now, "Receipt Signer", await keys(), receiptRoot, false, [
    new Extension({ extnID: "1.2.840.113635.100.12.15", extnValue: new asn1.Null().toBER() }),
  ]);
  const pair = await keys();
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("raw point expected");
  const point = new Uint8Array(exported);
  const id = await sha256(point);
  const clientData =
    options.clientData ??
    new TextEncoder().encode(
      "twitter-studio/enroll/v1\none-time-challenge\ninstallation-public-key",
    );
  const ext = encode(
    new Map<string, unknown>([
      ["apple_bundle_version_01", options.bundleVersion ?? "1"],
      [
        "apple_validation_category_01",
        new Uint8Array([options.category ?? (environment === "production" ? 4 : 3), 0, 0, 0]),
      ],
    ]),
  );
  const counter = new Uint8Array(4);
  const authData = concatenate(
    await sha256(new TextEncoder().encode(policy.appId)),
    new Uint8Array([options.attestationFlags ?? 0x40]),
    counter,
    environment === "production"
      ? concatenate(new TextEncoder().encode("appattest"), new Uint8Array(7))
      : new TextEncoder().encode("appattestdevelop"),
    new Uint8Array([0, 32]),
    id,
    encode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, point.slice(1, 33)],
        [-3, point.slice(33)],
      ]),
    ),
    ext,
  );
  const nonce = await sha256(concatenate(authData, await sha256(clientData)));
  const leaf = await issue(now, "Attested Key", pair, intermediate, false, [
    new Extension({
      extnID: "1.2.840.113635.100.8.2",
      extnValue: new asn1.Sequence({
        value: [
          new asn1.Constructed({
            idBlock: { tagClass: 3, tagNumber: 1 },
            value: [new asn1.OctetString({ valueHex: nonce.buffer })],
          }),
        ],
      }).toBER(),
    }),
  ]);
  const attribute = (type: number, value: Uint8Array) =>
    new asn1.Sequence({
      value: [
        new asn1.Integer({ value: type }),
        new asn1.Integer({ value: 1 }),
        new asn1.OctetString({ valueHex: new Uint8Array(value).buffer }),
      ],
    });
  const payload = new asn1.Set({
    value: [
      attribute(2, new TextEncoder().encode(policy.appId)),
      attribute(3, new Uint8Array(leaf.cert.toSchema(true).toBER())),
      attribute(6, new TextEncoder().encode("ATTEST")),
      attribute(12, new TextEncoder().encode(now.toISOString())),
    ],
  }).toBER();
  const signed = new SignedData({
    version: 1,
    certificates: [receiptSigner.cert, receiptRoot.cert],
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: "1.2.840.113549.1.7.1",
      eContent: new asn1.OctetString({ valueHex: payload }),
    }),
    signerInfos: [
      new SignerInfo({
        version: 1,
        sid: new IssuerAndSerialNumber({
          issuer: receiptSigner.cert.issuer,
          serialNumber: receiptSigner.cert.serialNumber,
        }),
      }),
    ],
  });
  await signed.sign(receiptSigner.keys.privateKey, 0, "SHA-256", undefined, engine());
  const receipt = new Uint8Array(
    new ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: signed.toSchema(true) })
      .toSchema()
      .toBER(),
  );
  const object = encode({
    fmt: "apple-appattest",
    attStmt: {
      x5c: [
        new Uint8Array(leaf.cert.toSchema(true).toBER()),
        new Uint8Array(intermediate.cert.toSchema(true).toBER()),
      ],
      receipt,
    },
    authData,
  });
  const verifier = createAppAttestVerifier({
    attestation: attRoot.cert,
    receipt: receiptRoot.cert,
  });
  const input = { object, keyId: id, clientData, policy: { ...policy, environment }, now };
  async function assertion(counterValue: number, assertionClientData = clientData) {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counterValue, false);
    const authenticatorData = concatenate(
      await sha256(new TextEncoder().encode(policy.appId)),
      new Uint8Array([options.assertionFlags ?? 0x00]),
      count,
      ext,
    );
    const composite = concatenate(authenticatorData, await sha256(assertionClientData));
    const signed =
      options.assertionSignatureInput === "composite" ? composite : await sha256(composite);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed),
    );
    const integer = (data: Uint8Array) => {
      let i = 0;
      while (data[i] === 0 && i < data.length - 1) i++;
      const value = data.slice(i);
      return new asn1.Integer({
        valueHex: new Uint8Array((value[0] ?? 0) >= 128 ? [0, ...value] : value).buffer,
      });
    };
    const signature = new Uint8Array(
      new asn1.Sequence({ value: [integer(raw.slice(0, 32)), integer(raw.slice(32))] }).toBER(),
    );
    return encode({ authenticatorData, signature });
  }
  return { input, verifier, point, receipt, assertion, attRoot, receiptRoot, leaf };
}
