import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type DeviceTokenBinding,
  DeviceTokenCiphertextError,
  DeviceTokenKeyError,
  fingerprintDeviceToken,
  InvalidDeviceTokenError,
  keyCheckValue,
  loadDeviceTokenKeys,
  normalizeDeviceToken,
  openDeviceToken,
  sealDeviceToken,
} from "../../src/security/device-token";

const TOKEN = "a".repeat(64);
const KEY_1 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const KEY_2 = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";
const FINGERPRINT_KEY = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=";
// 鍵の確かめの値と、決まった鍵とトークンから作った指紋・暗号文は、このコードとは別に (Python と Node.js で) 計算した値。
// エンコードや小文字にそろえる処理が変わると、DB にある全部の指紋と暗号文が合わなくなるので、決まった値で確かめる。
const CHECK_1 = "8242446efc984a7c";
const CHECK_2 = "5d0c4d5683213666";
const FINGERPRINT_CHECK = "ded9776b92b0a8e2";
const KNOWN_FINGERPRINT = "f1.KKAm1CexCGaJ8AsGlz9d7udthnmGYit6XxR5DNrl8LA";
const KNOWN_CIPHERTEXT =
  "v1.test-1.AQIDBAUGBwgJCgsM.ZIs7tI31kectwwImcXKLSSMigJ_2DDGkwD6YRf_XF6Tlhfq-D9SN_tHN24Skupk8_5cugbX4VxBXHG2sDmBVbTFRx9XmMt7YoqPmOwr23Z8";

const binding: DeviceTokenBinding = {
  installationId: "installation-1",
  apnsEnvironment: "sandbox",
  topic: "com.twitter-studio.Tweetbot",
};

function keyEnv(keyring: object, checks: object, fingerprintKey = FINGERPRINT_KEY) {
  return {
    DEVICE_TOKEN_KEYS: JSON.stringify(keyring),
    DEVICE_TOKEN_FINGERPRINT_KEY: fingerprintKey,
    DEVICE_TOKEN_KEY_CHECKS: JSON.stringify(checks),
  };
}

describe("デバイストークンの暗号化", () => {
  it("暗号文から元のトークンに戻り、暗号文にはトークンも鍵も入らず、毎回違う", async () => {
    const keys = await loadDeviceTokenKeys(env);

    const first = await sealDeviceToken(keys, TOKEN, binding);
    const second = await sealDeviceToken(keys, TOKEN, binding);

    expect(first.ciphertext.startsWith("v1.test-1.")).toBe(true);
    expect(first.ciphertext).not.toContain(TOKEN);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(await openDeviceToken(keys, { ...binding, ...first })).toBe(TOKEN);
  });

  it("決まった鍵とトークンから、決まった指紋になり、決まった暗号文から元のトークンに戻る", async () => {
    const keys = await loadDeviceTokenKeys(env);

    expect(await fingerprintDeviceToken(keys, TOKEN)).toBe(KNOWN_FINGERPRINT);
    expect(
      await openDeviceToken(keys, {
        ...binding,
        installationId: "installation-kat",
        ciphertext: KNOWN_CIPHERTEXT,
        fingerprint: KNOWN_FINGERPRINT,
      }),
    ).toBe(TOKEN);
  });

  it("ほかの行 (インストール、環境、topic) に写した暗号文と、指紋の合わない暗号文は読まない", async () => {
    const keys = await loadDeviceTokenKeys(env);
    const sealed = await sealDeviceToken(keys, TOKEN, binding);
    const other = await sealDeviceToken(keys, "b".repeat(64), binding);

    for (const moved of [
      { ...binding, installationId: "installation-2" },
      { ...binding, apnsEnvironment: "production" as const },
      { ...binding, topic: "other.topic" },
    ]) {
      await expect(openDeviceToken(keys, { ...moved, ...sealed })).rejects.toThrow(
        DeviceTokenCiphertextError,
      );
    }
    await expect(
      openDeviceToken(keys, {
        ...binding,
        ciphertext: sealed.ciphertext,
        fingerprint: other.fingerprint,
      }),
    ).rejects.toThrow(DeviceTokenCiphertextError);
  });

  it("用途の違う追加の認証データで作った暗号文は読まない", async () => {
    const keys = await loadDeviceTokenKeys(env);
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(KEY_1), (c) => c.charCodeAt(0)),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const iv = new Uint8Array(12);
    const body = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode("other-purpose") },
        key,
        new TextEncoder().encode(TOKEN),
      ),
    );
    const b64u = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");

    await expect(
      openDeviceToken(keys, {
        ...binding,
        ciphertext: `v1.test-1.${b64u(iv)}.${b64u(body)}`,
        fingerprint: KNOWN_FINGERPRINT,
      }),
    ).rejects.toThrow(DeviceTokenCiphertextError);
  });

  it("形の違う暗号文、書き換えた暗号文、鍵のない暗号文は読まない", async () => {
    const keys = await loadDeviceTokenKeys(env);
    const { ciphertext, fingerprint } = await sealDeviceToken(keys, TOKEN, binding);
    const [, keyId, iv = "", body = ""] = ciphertext.split(".");
    const flip = (text: string) =>
      `${text.slice(0, 2)}${text[2] === "A" ? "B" : "A"}${text.slice(3)}`;

    for (const broken of [
      "plain-token",
      `v2.${keyId}.${iv}.${body}`,
      `v1.${keyId}.${iv}.${body}.extra`,
      `v1.${keyId}..${body}`,
      `v1.missing.${iv}.${body}`,
      `v1.${keyId}.${flip(iv)}.${body}`,
      `v1.${keyId}.${iv}.${flip(body)}`,
      `v1.${keyId}.${iv}AAAA.${body}`,
      `v1.${keyId}.${iv}.${body.slice(0, 10)} ${body.slice(10)}`,
    ]) {
      await expect(
        openDeviceToken(keys, { ...binding, ciphertext: broken, fingerprint }),
        broken,
      ).rejects.toThrow(DeviceTokenCiphertextError);
    }
  });

  it("鍵の入れ替えは 2 段で行える。足しただけなら古い鍵で書き、current にすると新しい鍵で書き、どちらも読める", async () => {
    const checks = { fingerprint: FINGERPRINT_CHECK, keys: { k1: CHECK_1, k2: CHECK_2 } };
    const before = await loadDeviceTokenKeys(
      keyEnv({ current: "k1", keys: { k1: KEY_1 } }, checks),
    );
    const old = await sealDeviceToken(before, TOKEN, binding);

    const added = await loadDeviceTokenKeys(
      keyEnv({ current: "k1", keys: { k1: KEY_1, k2: KEY_2 } }, checks),
    );
    const switched = await loadDeviceTokenKeys(
      keyEnv({ current: "k2", keys: { k1: KEY_1, k2: KEY_2 } }, checks),
    );

    expect((await sealDeviceToken(added, TOKEN, binding)).ciphertext.startsWith("v1.k1.")).toBe(
      true,
    );
    const fresh = await sealDeviceToken(switched, TOKEN, binding);
    expect(fresh.ciphertext.startsWith("v1.k2.")).toBe(true);
    expect(await openDeviceToken(added, { ...binding, ...fresh })).toBe(TOKEN);
    expect(await openDeviceToken(switched, { ...binding, ...old })).toBe(TOKEN);

    const removed = await loadDeviceTokenKeys(
      keyEnv({ current: "k2", keys: { k2: KEY_2 } }, checks),
    );
    await expect(openDeviceToken(removed, { ...binding, ...old })).rejects.toThrow(
      DeviceTokenCiphertextError,
    );
  });
});

describe("鍵の読み込み", () => {
  const checks = { fingerprint: FINGERPRINT_CHECK, keys: { k1: CHECK_1 } };

  it("鍵の確かめの値は、このコードとは別に計算した値と合う", async () => {
    expect(await keyCheckValue(Uint8Array.from(atob(KEY_1), (c) => c.charCodeAt(0)))).toBe(CHECK_1);
  });

  it("形の違う鍵束、確かめの値の合わない鍵、暗号化と同じ指紋の鍵は拒み、エラーの文に鍵の値を入れない", async () => {
    const short = "c2hvcnQ=";
    for (const [name, keyEnvValue] of [
      ["not json", { ...keyEnv({}, checks), DEVICE_TOKEN_KEYS: "not json" }],
      ["current missing", keyEnv({ current: "k2", keys: { k1: KEY_1 } }, checks)],
      ["short key", keyEnv({ current: "k1", keys: { k1: short } }, checks)],
      ["bad key id", keyEnv({ current: "bad.id", keys: { "bad.id": KEY_1 } }, checks)],
      ["mistyped old key", keyEnv({ current: "k1", keys: { k1: KEY_2 } }, checks)],
      ["key without check", keyEnv({ current: "k1", keys: { k1: KEY_1, k2: KEY_2 } }, checks)],
      ["mistyped fingerprint key", keyEnv({ current: "k1", keys: { k1: KEY_1 } }, checks, KEY_2)],
      [
        "fingerprint key reused",
        keyEnv({ current: "k1", keys: { k1: KEY_1 } }, { ...checks, fingerprint: CHECK_1 }, KEY_1),
      ],
      [
        "fingerprint key not base64",
        keyEnv({ current: "k1", keys: { k1: KEY_1 } }, checks, "not base64!"),
      ],
    ] as const) {
      const error = await loadDeviceTokenKeys(keyEnvValue).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(DeviceTokenKeyError);
      for (const secret of [KEY_1, KEY_2, FINGERPRINT_KEY, short])
        expect(String(error), name).not.toContain(secret);
    }
  });

  it("エラーの種類は名前で見分けられる", () => {
    expect(new InvalidDeviceTokenError("x").name).toBe("InvalidDeviceTokenError");
    expect(new DeviceTokenKeyError("x").name).toBe("DeviceTokenKeyError");
    expect(new DeviceTokenCiphertextError("x").name).toBe("DeviceTokenCiphertextError");
  });
});

describe("デバイストークンの指紋と形", () => {
  it("同じトークン (大文字と小文字の違いを含む) には同じ指紋、違うトークンには違う指紋で、版が付く", async () => {
    const keys = await loadDeviceTokenKeys(env);

    const fingerprint = await fingerprintDeviceToken(keys, TOKEN);

    expect(fingerprint.startsWith("f1.")).toBe(true);
    expect(await fingerprintDeviceToken(keys, TOKEN.toUpperCase())).toBe(fingerprint);
    expect(await fingerprintDeviceToken(keys, "b".repeat(64))).not.toBe(fingerprint);
  });

  it("16 進数で、16〜128 バイトのものだけを受け付け、小文字にそろえる", () => {
    expect(normalizeDeviceToken("AB".repeat(32))).toBe("ab".repeat(32));
    expect(normalizeDeviceToken("a".repeat(32))).toBe("a".repeat(32));
    expect(normalizeDeviceToken("a".repeat(256))).toBe("a".repeat(256));
    for (const token of [
      "",
      "xyz",
      "a".repeat(63),
      "a".repeat(30),
      "a".repeat(258),
      `${"a".repeat(64)}\n`,
    ]) {
      expect(() => normalizeDeviceToken(token), JSON.stringify(token)).toThrow(
        InvalidDeviceTokenError,
      );
    }
  });
});

describe("鍵の設定の誤り", () => {
  const checks = { fingerprint: "ded9776b92b0a8e2", keys: { k1: "8242446efc984a7c" } };
  const keyring = { current: "k1", keys: { k1: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" } };

  it("秘密を置き忘れたときや、長さの合わない Base64 も、鍵の設定の誤りとして扱う", async () => {
    for (const fingerprintKey of [undefined, "AAAAA="]) {
      const error = await loadDeviceTokenKeys({
        DEVICE_TOKEN_KEYS: JSON.stringify(keyring),
        DEVICE_TOKEN_FINGERPRINT_KEY: fingerprintKey as unknown as string,
        DEVICE_TOKEN_KEY_CHECKS: JSON.stringify(checks),
      }).catch((e: unknown) => e);
      expect(error, String(fingerprintKey)).toBeInstanceOf(DeviceTokenKeyError);
    }
  });

  it("current がオブジェクトの元の名前 (constructor など) でも、鍵がないとして拒む", async () => {
    for (const current of ["constructor", "toString", "__proto__"]) {
      const error = await loadDeviceTokenKeys({
        DEVICE_TOKEN_KEYS: JSON.stringify({ ...keyring, current }),
        DEVICE_TOKEN_FINGERPRINT_KEY: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=",
        DEVICE_TOKEN_KEY_CHECKS: JSON.stringify(checks),
      }).catch((e: unknown) => e);
      expect(error, current).toBeInstanceOf(DeviceTokenKeyError);
    }
  });
});
