import { env, exports } from "cloudflare:workers";
import {
  createDb,
  deleteAccount,
  findActiveRelayCredential,
  findActiveSession,
  revokeInstallation,
} from "@notification-service/db";
import { describe, expect, it, vi } from "vitest";
import { createApp, MAX_BODY_BYTES } from "../src/app";
import { hashBearerToken } from "../src/security/bearer";
import { fromBase64Url, toBase64Url } from "../src/security/encoding";
import { enrollmentMessage, sessionMessage } from "../src/security/installation-key";
import { newDeviceKey } from "./helpers/device-key";
import { jsonHeaders } from "./helpers/http";

const INVITE = "test-invite-code-0123456789";

async function post(path: string, body: unknown, headers = jsonHeaders()) {
  return exports.default.fetch(`https://notification.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function challenge(purpose: "enroll" | "session", headers = jsonHeaders()) {
  const response = await post("/v1/enrollments/challenge", { purpose }, headers);
  expect(response.status).toBe(200);
  return (await response.json<{ challenge: string }>()).challenge;
}

async function enroll(
  device: Awaited<ReturnType<typeof newDeviceKey>>,
  overrides: Record<string, string> = {},
) {
  const issued = overrides.challenge ?? (await challenge("enroll"));
  return post("/v1/enrollments", {
    challenge: issued,
    public_key: device.publicKey,
    signature:
      overrides.signature ?? (await device.sign(enrollmentMessage(issued, device.publicKey))),
    invite_code: overrides.invite_code ?? INVITE,
  });
}

type Enrolled = {
  account_id: string;
  installation_id: string;
  session: { token: string; expires_at: string };
  relay_secret?: string;
  relay_credential_id?: string;
};

async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  return response.json<{ title: string; detail?: string }>();
}

describe("端末の登録", () => {
  it("署名したチャレンジで登録すると、アカウント、セッション、1 回だけ見せる中継の資格情報を返す", async () => {
    const device = await newDeviceKey();

    const response = await enroll(device);

    expect(response.status).toBe(201);
    const body = await response.json<Enrolled>();
    expect(body.session.token).toMatch(/^tss_[A-Za-z0-9_-]{43}$/);
    expect(body.relay_secret).toMatch(/^tsr_[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const db = createDb(env.DB);
    expect(
      await findActiveRelayCredential(db, await hashBearerToken(body.relay_secret ?? "")),
    ).toMatchObject({ id: body.relay_credential_id, accountId: body.account_id });
    expect(
      (await findActiveSession(db, await hashBearerToken(body.session.token)))?.installationId,
    ).toBe(body.installation_id);
  });

  it("DB には、セッションと中継の資格情報の平文を置かない", async () => {
    const body = await (await enroll(await newDeviceKey())).json<Enrolled>();

    for (const [table, column] of [
      ["sessions", "token_hash"],
      ["relay_credentials", "secret_hash"],
    ] as const) {
      const rows = await env.DB.prepare(`SELECT ${column} AS value FROM ${table}`).all<{
        value: string;
      }>();
      for (const row of rows.results) {
        expect(row.value).not.toBe(body.session.token);
        expect(row.value).not.toBe(body.relay_secret);
      }
    }
  });

  it("使ったチャレンジは、ほかの鍵の登録に使い回せない", async () => {
    const issued = await challenge("enroll");
    expect((await enroll(await newDeviceKey(), { challenge: issued })).status).toBe(201);

    await expectProblem(await enroll(await newDeviceKey(), { challenge: issued }), 409);
  });

  it("同じ鍵と同じチャレンジの 2 回目は、409 で拒む", async () => {
    const device = await newDeviceKey();
    const issued = await challenge("enroll");
    const signature = await device.sign(enrollmentMessage(issued, device.publicKey));
    await enroll(device, { challenge: issued, signature });

    await expectProblem(await enroll(device, { challenge: issued, signature }), 409);
  });

  it("同じ鍵で新しいチャレンジから登録し直すと、前のアカウントのセッションだけを返し、資格情報は返さない", async () => {
    const device = await newDeviceKey();
    const first = await (await enroll(device)).json<Enrolled>();

    const retried = await enroll(device);

    expect(retried.status).toBe(200);
    const body = await retried.json<Enrolled>();
    expect(body.account_id).toBe(first.account_id);
    expect(body.relay_secret).toBeUndefined();
    expect(body.session.token).not.toBe(first.session.token);
  });

  it("招待のコードが違う、登録を受け付けていない、招待の秘密が短いときは、同じ 403 にする", async () => {
    const wrong = await expectProblem(
      await enroll(await newDeviceKey(), { invite_code: "wrong" }),
      403,
    );

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const secret of ["", "short-invite-code"]) {
      const device = await newDeviceKey();
      const issued = await challenge("enroll");
      const closed = await createApp().request(
        "https://notification.test/v1/enrollments",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            challenge: issued,
            public_key: device.publicKey,
            signature: await device.sign(enrollmentMessage(issued, device.publicKey)),
            invite_code: secret,
          }),
        },
        { ...env, ENROLLMENT_INVITE_CODE: secret },
      );
      expect((await expectProblem(closed, 403)).detail, secret).toBe(wrong.detail);
    }
    // 短い秘密は、オーナーが気づけるようにログに出す (値は出さない)。
    expect(JSON.stringify(log.mock.calls)).toContain("enrollment_invite_code_too_short");
    expect(JSON.stringify(log.mock.calls)).not.toContain("short-invite-code");
    log.mockRestore();
  });

  it("書き方だけが違う同じ公開鍵 (使わないビット) は受け付けず、別のアカウントを作らせない", async () => {
    const device = await newDeviceKey();
    await enroll(device);
    // 65 バイトの Base64URL は 87 文字で、最後の文字の下の 2 ビットは使わない。
    const last = device.publicKey.at(-1) ?? "A";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const variant = `${device.publicKey.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}`;
    const issued = await challenge("enroll");

    const response = await post("/v1/enrollments", {
      challenge: issued,
      public_key: variant,
      signature: await device.sign(enrollmentMessage(issued, variant)),
      invite_code: INVITE,
    });

    expect((await expectProblem(response, 422)).detail).toBe("The public key is invalid.");
  });

  it("署名が違うときはチャレンジを使ったことにせず、正しい署名なら同じチャレンジで登録できる", async () => {
    const device = await newDeviceKey();
    const issued = await challenge("enroll");
    await expectProblem(
      await enroll(device, { challenge: issued, signature: await device.sign("other") }),
      401,
    );

    expect((await enroll(device, { challenge: issued })).status).toBe(201);
  });

  it("曲線の上にない点の公開鍵と、DER の形の署名は 401", async () => {
    const offCurve = new Uint8Array(65);
    offCurve[0] = 0x04;
    offCurve.fill(1, 1);
    const issued = await challenge("enroll");
    const fake = toBase64Url(offCurve);
    await expectProblem(
      await post("/v1/enrollments", {
        challenge: issued,
        public_key: fake,
        signature: toBase64Url(new Uint8Array(64).fill(1)),
        invite_code: INVITE,
      }),
      401,
    );

    const device = await newDeviceKey();
    const derIssued = await challenge("enroll");
    const raw = fromBase64Url(await device.sign(enrollmentMessage(derIssued, device.publicKey)));
    await expectProblem(
      await enroll(device, { challenge: derIssued, signature: toBase64Url(toDer(raw)) }),
      401,
    );
  });

  it("同じチャレンジで同時に登録すると、1 つだけが通り、ほかは 409", async () => {
    const issued = await challenge("enroll");

    const statuses = await Promise.all(
      [await newDeviceKey(), await newDeviceKey()].map(
        async (device) => (await enroll(device, { challenge: issued })).status,
      ),
    );

    expect(statuses.sort()).toEqual([201, 409]);
  });

  it("同じ鍵で同時に登録すると、アカウントは 1 つだけ作り、もう一方はそのアカウントのセッションを返す", async () => {
    const device = await newDeviceKey();

    const responses = await Promise.all([enroll(device), enroll(device)]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const [first, second] = await Promise.all(
      responses.map((response) => response.json<Enrolled>()),
    );
    expect(first?.account_id).toBe(second?.account_id);
  });

  it("取り消したインストールや止めたアカウントの鍵では登録し直せず、消したアカウントの鍵なら新しいアカウントになる", async () => {
    const db = createDb(env.DB);
    const revoked = await newDeviceKey();
    const revokedBody = await (await enroll(revoked)).json<Enrolled>();
    await revokeInstallation(db, {
      accountId: revokedBody.account_id,
      installationId: revokedBody.installation_id,
    });
    const disabled = await newDeviceKey();
    const disabledBody = await (await enroll(disabled)).json<Enrolled>();
    await env.DB.prepare("UPDATE notification_accounts SET state = 'disabled' WHERE id = ?")
      .bind(disabledBody.account_id)
      .run();
    const deleted = await newDeviceKey();
    const deletedBody = await (await enroll(deleted)).json<Enrolled>();
    await deleteAccount(db, { accountId: deletedBody.account_id });

    await expectProblem(await enroll(revoked), 403);
    await expectProblem(await enroll(disabled), 403);
    const reenrolled = await enroll(deleted);
    expect(reenrolled.status).toBe(201);
    expect((await reenrolled.json<Enrolled>()).account_id).not.toBe(deletedBody.account_id);
  });

  it("同じ IP からの呼び出しが多すぎると、429 と Retry-After を返す", async () => {
    const headers = jsonHeaders();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await post("/v1/enrollments/challenge", { purpose: "enroll" }, headers);
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get("Retry-After")).toBe("60");
        await expectProblem(response, 429);
      }
    }

    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // ほかの IP は数えない。
    expect((await post("/v1/enrollments/challenge", { purpose: "enroll" })).status).toBe(200);
  });

  it("署名が違う (ほかの鍵、ほかの文、セッション用のチャレンジ) ときは、401", async () => {
    const device = await newDeviceKey();
    const other = await newDeviceKey();
    const issued = await challenge("enroll");

    await expectProblem(
      await enroll(device, {
        challenge: issued,
        signature: await other.sign(enrollmentMessage(issued, device.publicKey)),
      }),
      401,
    );
    await expectProblem(
      await enroll(device, { signature: await device.sign("something else") }),
      401,
    );
    const sessionChallenge = await challenge("session");
    await expectProblem(
      await enroll(device, {
        challenge: sessionChallenge,
        signature: await device.sign(enrollmentMessage(sessionChallenge, device.publicKey)),
      }),
      401,
    );
  });

  it("公開鍵の形が違う、入力が足りないときは 422、本文が大きすぎるときは 413", async () => {
    const issued = await challenge("enroll");
    await expectProblem(
      await post("/v1/enrollments", {
        challenge: issued,
        public_key: "AAAA",
        signature: "AAAA",
        invite_code: INVITE,
      }),
      422,
    );
    await expectProblem(await post("/v1/enrollments", { challenge: issued }), 422);
    await expectProblem(await post("/v1/enrollments/challenge", { purpose: "other" }), 422);
    await expectProblem(
      await post("/v1/sessions", {
        installation_id: "not-a-uuid",
        challenge: issued,
        signature: "AAAA",
      }),
      422,
    );
    await expectProblem(
      await post("/v1/enrollments", { padding: "x".repeat(MAX_BODY_BYTES) }),
      413,
    );
  });
});

describe("セッションの作り直し", () => {
  it("インストールの鍵で署名すると、新しいセッションを返す", async () => {
    const device = await newDeviceKey();
    const enrolled = await (await enroll(device)).json<Enrolled>();
    const issued = await challenge("session");

    const response = await post("/v1/sessions", {
      installation_id: enrolled.installation_id,
      challenge: issued,
      signature: await device.sign(sessionMessage(issued, enrolled.installation_id)),
    });

    expect(response.status).toBe(201);
    const body = await response.json<{ session: { token: string } }>();
    expect(
      (await findActiveSession(createDb(env.DB), await hashBearerToken(body.session.token)))
        ?.accountId,
    ).toBe(enrolled.account_id);
  });

  it("ほかの鍵の署名、ないインストール、取り消したインストールは、同じ 401 で拒む", async () => {
    const device = await newDeviceKey();
    const enrolled = await (await enroll(device)).json<Enrolled>();
    const other = await newDeviceKey();

    const attempt = async (signer: typeof device, installationId: string) => {
      const issued = await challenge("session");
      return post("/v1/sessions", {
        installation_id: installationId,
        challenge: issued,
        signature: await signer.sign(sessionMessage(issued, installationId)),
      });
    };

    const wrongKey = await expectProblem(await attempt(other, enrolled.installation_id), 401);
    const missing = await expectProblem(await attempt(device, crypto.randomUUID()), 401);
    expect(missing.detail).toBe(wrongKey.detail);

    await revokeInstallation(createDb(env.DB), {
      accountId: enrolled.account_id,
      installationId: enrolled.installation_id,
    });
    await expectProblem(await attempt(device, enrolled.installation_id), 401);
  });

  it("1 つのインストールがセッションを作り直しすぎると、429 を返す", async () => {
    const device = await newDeviceKey();
    const enrolled = await (await enroll(device)).json<Enrolled>();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const issued = await challenge("session");
      const response = await post("/v1/sessions", {
        installation_id: enrolled.installation_id,
        challenge: issued,
        signature: await device.sign(sessionMessage(issued, enrolled.installation_id)),
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("同じチャレンジでセッションを 2 回作れない", async () => {
    const device = await newDeviceKey();
    const enrolled = await (await enroll(device)).json<Enrolled>();
    const issued = await challenge("session");
    const body = {
      installation_id: enrolled.installation_id,
      challenge: issued,
      signature: await device.sign(sessionMessage(issued, enrolled.installation_id)),
    };
    expect((await post("/v1/sessions", body)).status).toBe(201);

    await expectProblem(await post("/v1/sessions", body), 409);
  });
});

/** r‖s の 64 バイトの署名を、DER (iOS の SecKeyCreateSignature の形) にする。 */
function toDer(raw: Uint8Array | undefined): Uint8Array {
  if (raw === undefined) throw new Error("signature is not Base64URL");
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.slice(start);
    const padded = (trimmed[0] ?? 0) >= 0x80 ? [0, ...trimmed] : [...trimmed];
    return [0x02, padded.length, ...padded];
  };
  const body = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}
