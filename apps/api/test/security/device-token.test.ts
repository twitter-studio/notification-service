import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DeviceTokenError,
  decryptDeviceToken,
  encryptDeviceToken,
  fingerprintDeviceToken,
  loadFingerprintKey,
  loadTokenKeyring,
  normalizeDeviceToken,
} from "../../src/security/device-token";

const TOKEN = "a".repeat(64);
const KEY_1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const KEY_2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";

describe("デバイストークンの暗号化", () => {
  it("暗号文から元のトークンに戻り、暗号文にはトークンも鍵も入らない", async () => {
    const keyring = await loadTokenKeyring(env.DEVICE_TOKEN_KEYS);

    const encrypted = await encryptDeviceToken(keyring, TOKEN);

    expect(encrypted.startsWith("v1.test-1.")).toBe(true);
    expect(encrypted).not.toContain(TOKEN);
    expect(await decryptDeviceToken(keyring, encrypted)).toBe(TOKEN);
  });

  it("同じトークンでも、毎回違う暗号文になる", async () => {
    const keyring = await loadTokenKeyring(env.DEVICE_TOKEN_KEYS);

    expect(await encryptDeviceToken(keyring, TOKEN)).not.toBe(
      await encryptDeviceToken(keyring, TOKEN),
    );
  });

  it("鍵を入れ替えても、古い鍵の暗号文を読め、新しい暗号文は新しい鍵で作る", async () => {
    const before = await loadTokenKeyring(JSON.stringify({ current: "k1", keys: { k1: KEY_1 } }));
    const old = await encryptDeviceToken(before, TOKEN);

    const after = await loadTokenKeyring(
      JSON.stringify({ current: "k2", keys: { k1: KEY_1, k2: KEY_2 } }),
    );

    expect(await decryptDeviceToken(after, old)).toBe(TOKEN);
    expect((await encryptDeviceToken(after, TOKEN)).startsWith("v1.k2.")).toBe(true);
  });

  it("鍵のない暗号文と、書き換えられた暗号文は読まない", async () => {
    const keyring = await loadTokenKeyring(JSON.stringify({ current: "k1", keys: { k1: KEY_1 } }));
    const encrypted = await encryptDeviceToken(keyring, TOKEN);
    const [version, , iv, ciphertext] = encrypted.split(".");
    const flipped = `${ciphertext?.slice(0, -2)}${ciphertext?.endsWith("A") ? "B" : "A"}${ciphertext?.slice(-1)}`;

    await expect(decryptDeviceToken(keyring, `${version}.k9.${iv}.${ciphertext}`)).rejects.toThrow(
      DeviceTokenError,
    );
    await expect(decryptDeviceToken(keyring, `${version}.k1.${iv}.${flipped}`)).rejects.toThrow(
      DeviceTokenError,
    );
    await expect(decryptDeviceToken(keyring, "plain-token")).rejects.toThrow(DeviceTokenError);
  });

  it("鍵束の形が違えば投げ、エラーの文に鍵の値を入れない", async () => {
    for (const json of [
      "not json",
      JSON.stringify({ current: "k2", keys: { k1: KEY_1 } }),
      JSON.stringify({ current: "k1", keys: { k1: "c2hvcnQ=" } }),
      JSON.stringify({ current: "bad.id", keys: { "bad.id": KEY_1 } }),
    ]) {
      const error = await loadTokenKeyring(json).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DeviceTokenError);
      expect(String(error)).not.toContain(KEY_1);
    }
  });
});

describe("デバイストークンの指紋", () => {
  it("同じトークン (大文字と小文字の違いを含む) には同じ指紋、違うトークンや違う鍵には違う指紋", async () => {
    const key = await loadFingerprintKey(env.DEVICE_TOKEN_FINGERPRINT_KEY);
    const otherKey = await loadFingerprintKey(KEY_1);

    const fingerprint = await fingerprintDeviceToken(key, TOKEN);

    expect(await fingerprintDeviceToken(key, TOKEN.toUpperCase())).toBe(fingerprint);
    expect(await fingerprintDeviceToken(key, "b".repeat(64))).not.toBe(fingerprint);
    expect(await fingerprintDeviceToken(otherKey, TOKEN)).not.toBe(fingerprint);
    expect(fingerprint).not.toContain(TOKEN);
  });
});

describe("デバイストークンの形", () => {
  it("16 進数で、16〜128 バイトのものだけを受け付け、小文字にそろえる", () => {
    expect(normalizeDeviceToken("AB".repeat(32))).toBe("ab".repeat(32));
    for (const token of ["", "xyz", "a".repeat(63), "a".repeat(30), "a".repeat(258)]) {
      expect(() => normalizeDeviceToken(token), token).toThrow(DeviceTokenError);
    }
  });
});
