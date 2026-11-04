import { decode, encode } from "cborg";
import { describe, expect, it } from "vitest";
import { InvalidAppAttest } from "../../../src/security/app-attest/data";
import { appleAppAttest, createAppAttestVerifier } from "../../../src/security/app-attest/verifier";
import { fixture } from "./fixtures";

describe("Apple App Attestの検証", () => {
  it("証明書とCMSの実署名を検証し、認証済みの公開鍵とreceiptを返す", async () => {
    const test = await fixture();
    const result = await test.verifier.attestation(test.input);
    expect(result.publicKey).toEqual(test.point);
    expect(result.keyId).toEqual(test.input.keyId);
    expect(result.receipt).toEqual(test.receipt);
    expect(result.counter).toBe(0);
  });
  it.each([
    "challenge",
    "key_id",
    "app_id",
    "environment",
    "bundle_version",
    "expired_receipt",
  ] as const)("%sの不一致を拒む", async (kind) => {
    const test = await fixture();
    let input: Parameters<typeof test.verifier.attestation>[0] = test.input;
    if (kind === "challenge") input = { ...input, clientData: new Uint8Array([1]) };
    if (kind === "key_id") input = { ...input, keyId: new Uint8Array(32) };
    if (kind === "app_id")
      input = { ...input, policy: { ...input.policy, appId: "OTHERTEAM1.com.example.attest" } };
    if (kind === "environment")
      return expect(
        test.verifier.attestation({
          ...input,
          policy: { ...input.policy, environment: "production" },
        }),
      ).rejects.toThrow(InvalidAppAttest);
    if (kind === "bundle_version")
      return expect(
        test.verifier.attestation({ ...input, policy: { ...input.policy, bundleVersions: ["2"] } }),
      ).rejects.toThrow(InvalidAppAttest);
    if (kind === "expired_receipt")
      input = { ...input, now: new Date(input.now.getTime() + 300001) };
    await expect(test.verifier.attestation(input)).rejects.toThrow(InvalidAppAttest);
  });
  it("assertionの実署名と増加するcounterを確かめ、使い回しを拒む", async () => {
    const test = await fixture();
    const object = await test.assertion(1);
    const input = {
      object,
      publicKey: test.point,
      previousCounter: 0,
      clientData: test.input.clientData,
      policy: test.input.policy,
    };
    expect(await test.verifier.assertion(input)).toBe(1);
    await expect(test.verifier.assertion({ ...input, previousCounter: 1 })).rejects.toThrow(
      InvalidAppAttest,
    );
    await expect(
      test.verifier.assertion({ ...input, clientData: new Uint8Array([0]) }),
    ).rejects.toThrow(InvalidAppAttest);
  });
});

it.each([
  "certificate_signature",
  "receipt_signature",
  "counter",
  "credential_id",
  "trailing_cbor",
] as const)("%sを改ざんしたattestationを拒み、入力をエラーに含めない", async (kind) => {
  const test = await fixture();
  const value: unknown = decode(test.input.object, { useMaps: true });
  if (!(value instanceof Map)) throw new Error("map expected");
  const statement: unknown = value.get("attStmt");
  if (!(statement instanceof Map)) throw new Error("map expected");
  if (kind === "certificate_signature") {
    const chain: unknown = statement.get("x5c");
    if (!Array.isArray(chain) || !(chain[0] instanceof Uint8Array))
      throw new Error("chain expected");
    const cert = new Uint8Array(chain[0]);
    cert[cert.length - 1] = (cert.at(-1) ?? 0) ^ 1;
    chain[0] = cert;
  }
  if (kind === "receipt_signature") {
    const original: unknown = statement.get("receipt");
    if (!(original instanceof Uint8Array)) throw new Error("receipt expected");
    const receipt = new Uint8Array(original);
    receipt[receipt.length - 1] = (receipt.at(-1) ?? 0) ^ 1;
    statement.set("receipt", receipt);
  }
  if (kind === "counter" || kind === "credential_id") {
    const original: unknown = value.get("authData");
    if (!(original instanceof Uint8Array)) throw new Error("bytes expected");
    const data = new Uint8Array(original);
    data[kind === "counter" ? 36 : 55] = 1;
    value.set("authData", data);
  }
  const encoded = encode(value);
  const object = kind === "trailing_cbor" ? new Uint8Array([...encoded, 0]) : encoded;
  await expect(test.verifier.attestation({ ...test.input, object })).rejects.toThrow(
    "invalid_app_attest",
  );
});
it("任意の自己署名CAをAppleのtrust anchorとして受け入れない", async () => {
  const test = await fixture();
  await expect(appleAppAttest.attestation(test.input)).rejects.toThrow(InvalidAppAttest);
  const verifier = createAppAttestVerifier({
    attestation: test.receiptRoot.cert,
    receipt: test.receiptRoot.cert,
  });
  await expect(verifier.attestation(test.input)).rejects.toThrow(InvalidAppAttest);
});

it.each([0x40, 0xc0])(
  "Apple公開例のflagsを含むattestation flags=%iで署名済みの拡張を検証する",
  async (flags) => {
    const test = await fixture({ attestationFlags: flags });
    expect((await test.verifier.attestation(test.input)).counter).toBe(0);
    await expect(
      test.verifier.attestation({
        ...test.input,
        policy: { ...test.input.policy, bundleVersions: ["wrong"] },
      }),
    ).rejects.toThrow(InvalidAppAttest);
  },
);
it.each([0x00, 0x80, 0xc0])("assertion flags=%iでも拡張と署名を検証する", async (flags) => {
  const test = await fixture({ assertionFlags: flags });
  expect(
    await test.verifier.assertion({
      object: await test.assertion(1),
      publicKey: test.point,
      previousCounter: 0,
      clientData: test.input.clientData,
      policy: test.input.policy,
    }),
  ).toBe(1);
  await expect(
    test.verifier.assertion({
      object: await test.assertion(1),
      publicKey: test.point,
      previousCounter: 0,
      clientData: test.input.clientData,
      policy: { ...test.input.policy, bundleVersions: ["wrong"] },
    }),
  ).rejects.toThrow(InvalidAppAttest);
  await expect(
    test.verifier.assertion({
      object: await test.assertion(1),
      publicKey: test.point,
      previousCounter: 0,
      clientData: new TextEncoder().encode("wrong"),
      policy: test.input.policy,
    }),
  ).rejects.toThrow(InvalidAppAttest);
});
it.each([0x40, 0x81, 0xc1, 0xff])("assertionの未対応flags=%iを拒む", async (flags) => {
  const test = await fixture({ assertionFlags: flags });
  await expect(
    test.verifier.assertion({
      object: await test.assertion(1),
      publicKey: test.point,
      previousCounter: 0,
      clientData: test.input.clientData,
      policy: test.input.policy,
    }),
  ).rejects.toThrow(InvalidAppAttest);
});
it.each([0x00, 0x41, 0xc1, 0xff])("attestationの用途に合わないflags=%iを拒む", async (flags) => {
  const test = await fixture({ attestationFlags: flags });
  await expect(test.verifier.attestation(test.input)).rejects.toThrow(InvalidAppAttest);
});

it("nonceではなく合成データへ直接付けたassertion署名を拒む", async () => {
  const test = await fixture({ assertionSignatureInput: "composite" });
  await expect(
    test.verifier.assertion({
      object: await test.assertion(1),
      publicKey: test.point,
      previousCounter: 0,
      clientData: test.input.clientData,
      policy: test.input.policy,
    }),
  ).rejects.toThrow(InvalidAppAttest);
});
