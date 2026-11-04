import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareCredentials, saveCredentials, sendProbe } from "./probe.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const credentials = () =>
  prepareCredentials({ privateKey: pem, keyId: "TESTKEY123", teamId: "TESTTEAM12" });
const result = {
  kind: "apns_response",
  request_id: "00000000-0000-4000-8000-000000000001",
  elapsed_ms: 10,
  http_protocol: "not_exposed",
  cpu_ms: null,
  status: 200,
  apns_id: null,
  reason: null,
};

test("APNs JWT は ES256 の64バイト署名で、秘密鍵を含まず、検証窓は10分", () => {
  const now = Date.now();
  const value = prepareCredentials({
    privateKey: pem,
    keyId: "TESTKEY123",
    teamId: "TESTTEAM12",
    now,
  });
  const [header, body, signature] = value.APNS_PROVIDER_TOKEN.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "ES256",
    kid: "TESTKEY123",
  });
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url")), {
    iss: "TESTTEAM12",
    iat: Math.floor(now / 1000),
  });
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${header}.${body}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  assert.equal(Date.parse(value.PROBE_EXPIRES_AT) - now, 600_000);
  assert.equal(JSON.stringify(value).includes("PRIVATE KEY"), false);
});

test("秘密は0600で新規保存し、既存ファイルとGit管理内には書かない", async () => {
  const folder = await mkdtemp(join(tmpdir(), "apns-probe-test-"));
  try {
    const path = join(folder, "credentials.json");
    const value = credentials();
    await saveCredentials(path, value);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value);
    await assert.rejects(saveCredentials(path, value));
    await mkdir(join(folder, ".git"));
    await assert.rejects(saveCredentials(join(folder, "refused.json"), value));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("CLI はリダイレクトを拒否し、応答の未知の項目を捨てる", async () => {
  const value = await sendProbe({
    origin: "https://notification-apns-probe.example.workers.dev",
    credentials: credentials(),
    token: "01".repeat(32),
    send: async (_url, options) => {
      assert.equal(options.redirect, "error");
      return Response.json({ ...result, secret: "must-not-escape" });
    },
  });
  assert.deepEqual(value, result);
});

test("送り先のpath・query・HTTPと、不正な応答を受けない", async () => {
  for (const origin of [
    "http://test.workers.dev",
    "https://test.workers.dev/other",
    "https://test.workers.dev/?key=x",
    "https://test.example",
  ]) {
    await assert.rejects(
      sendProbe({
        origin,
        credentials: credentials(),
        token: "01".repeat(32),
        send: async () => {
          throw new Error("must not send");
        },
      }),
    );
  }
  await assert.rejects(
    sendProbe({
      origin: "https://test.workers.dev",
      credentials: credentials(),
      token: "01".repeat(32),
      send: async () => Response.json({ ...result, reason: "private-value" }),
    }),
  );
});

test("Git外のsymlinkからGit内の保存先を指しても秘密を書き出さない", async () => {
  const folder = await mkdtemp(join(tmpdir(), "apns-probe-symlink-"));
  try {
    const repository = join(folder, "repository");
    await mkdir(repository, { mode: 0o700 });
    await mkdir(join(repository, ".git"));
    const destination = join(repository, "private");
    await mkdir(destination, { mode: 0o700 });
    await symlink(destination, join(folder, "outside"));
    await assert.rejects(
      saveCredentials(join(folder, "outside", "credentials.json"), credentials()),
    );
    await assert.rejects(stat(join(destination, "credentials.json")), { code: "ENOENT" });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
