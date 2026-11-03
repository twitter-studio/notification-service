import { describe, expect, it } from "vitest";
import {
  enrollmentMessage,
  parseInstallationPublicKey,
  verifyInstallationSignature,
} from "../../src/security/installation-key";

// iOS の CryptoKit (P256.Signing、macOS の swift で 2026-11 に作った) の公開鍵と署名。秘密鍵は作ってすぐ捨てた。
// 公開鍵は x963Representation、署名は rawRepresentation と derRepresentation を、Base64URL (= なし) にしたもの。
const CRYPTOKIT = {
  publicKey:
    "BBx9BKRpzq8IUWlvUFWMZN5TBlmmctJmeqgCnxNRxdhVNJ7LU5YauHZYcecnf35rvPVGi0-k9nAK2M3kVeXVFaQ",
  challenge: "c1.fixture-challenge.fixture-mac",
  rawSignature:
    "iYifwBjWR_oNr2hvBx6xSo2vC4uL1j8F7uOZn8OCA9o_rioE7AhdKgTAp1qbFYL34bnaIQUlPxP0u4078-JlPQ",
  derSignature:
    "MEUCIQCJiJ_AGNZH-g2vaG8HHrFKja8Li4vWPwXu45mfw4ID2gIgP64qBOwIXSoEwKdamxWC9-G52iEFJT8T9LuNO_PiZT0",
};

describe("端末の鍵の署名", () => {
  it("CryptoKit の公開鍵 (x963Representation) と署名 (rawRepresentation) を確かめられる", async () => {
    const publicKey = parseInstallationPublicKey(CRYPTOKIT.publicKey);
    const message = enrollmentMessage(CRYPTOKIT.challenge, CRYPTOKIT.publicKey);

    expect(await verifyInstallationSignature(publicKey, message, CRYPTOKIT.rawSignature)).toBe(
      true,
    );
    expect(
      await verifyInstallationSignature(publicKey, `${message}x`, CRYPTOKIT.rawSignature),
    ).toBe(false);
  });

  it("DER の署名 (derRepresentation、SecKeyCreateSignature の形) は受けない", async () => {
    const publicKey = parseInstallationPublicKey(CRYPTOKIT.publicKey);
    const message = enrollmentMessage(CRYPTOKIT.challenge, CRYPTOKIT.publicKey);

    expect(await verifyInstallationSignature(publicKey, message, CRYPTOKIT.derSignature)).toBe(
      false,
    );
  });
});
