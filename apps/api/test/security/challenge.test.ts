import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CHALLENGE_TTL_MS,
  ChallengeKeyError,
  InvalidChallengeError,
  issueChallenge,
  loadChallengeKey,
  verifyChallenge,
} from "../../src/security/challenge";

const now = new Date("2026-11-04T00:00:00.000Z");

describe("チャレンジ", () => {
  it("出したチャレンジは、同じ用途で期限内なら確かめられ、使ったものとして記録する nonce と期限を返す", async () => {
    const key = await loadChallengeKey(env.CHALLENGE_SIGNING_KEY);
    const issued = await issueChallenge(key, "enroll", now);

    const verified = await verifyChallenge(key, issued.challenge, "enroll", now);

    expect(verified.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verified.expiresAt).toEqual(new Date(now.getTime() + CHALLENGE_TTL_MS));
  });

  it("毎回違うチャレンジになる", async () => {
    const key = await loadChallengeKey(env.CHALLENGE_SIGNING_KEY);

    expect((await issueChallenge(key, "enroll", now)).challenge).not.toBe(
      (await issueChallenge(key, "enroll", now)).challenge,
    );
  });

  it("用途の違うもの、期限を過ぎたもの、作った覚えのない先の期限のものは拒む", async () => {
    const key = await loadChallengeKey(env.CHALLENGE_SIGNING_KEY);
    const issued = await issueChallenge(key, "enroll", now);
    const future = await issueChallenge(key, "enroll", new Date(now.getTime() + 60 * 60 * 1000));

    await expect(verifyChallenge(key, issued.challenge, "session", now)).rejects.toThrow(
      InvalidChallengeError,
    );
    await expect(
      verifyChallenge(key, issued.challenge, "enroll", issued.expiresAt),
    ).rejects.toThrow(InvalidChallengeError);
    await expect(verifyChallenge(key, future.challenge, "enroll", now)).rejects.toThrow(
      InvalidChallengeError,
    );
  });

  it("書き換えたもの、ほかの鍵で署名したもの、形の違うものは拒む", async () => {
    const key = await loadChallengeKey(env.CHALLENGE_SIGNING_KEY);
    const otherKey = await loadChallengeKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
    const { challenge } = await issueChallenge(key, "enroll", now);
    const [version, payload = "", mac = ""] = challenge.split(".");
    const flip = (text: string) =>
      `${text.slice(0, 5)}${text[5] === "A" ? "B" : "A"}${text.slice(6)}`;
    const forged = (await issueChallenge(otherKey, "enroll", now)).challenge;

    for (const broken of [
      `${version}.${flip(payload)}.${mac}`,
      `${version}.${payload}.${flip(mac)}`,
      `c2.${payload}.${mac}`,
      `${version}.${payload}`,
      `${version}.${payload}.${mac}.extra`,
      `${version}.${payload} .${mac}`,
      forged,
      "",
    ]) {
      await expect(verifyChallenge(key, broken, "enroll", now), broken).rejects.toThrow(
        InvalidChallengeError,
      );
    }
  });

  it("署名の鍵がない、形が違うときは、鍵の設定の誤りとして扱う", async () => {
    for (const encoded of [undefined, "", "c2hvcnQ=", "not base64!"]) {
      await expect(loadChallengeKey(encoded), String(encoded)).rejects.toThrow(ChallengeKeyError);
    }
  });
});
