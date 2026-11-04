import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configuration, evidence } from "../src/schema.ts";

export function prepareCredentials({ privateKey, keyId, teamId, now = Date.now() }) {
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error("Invalid identifiers");
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("P256 key required");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const message = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" });
  return configuration.parse({
    APNS_PROVIDER_TOKEN: `${message}.${signature.toString("base64url")}`,
    PROBE_AUTH_TOKEN: randomBytes(32).toString("base64url"),
    PROBE_EXPIRES_AT: new Date(now + 10 * 60 * 1000).toISOString(),
  });
}

async function privateFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 4096)
    throw new Error("Private file required");
  return readFile(path, "utf8");
}

export async function saveCredentials(path, credentials) {
  const requested = resolve(path);
  let folder = await realpath(dirname(requested));
  const full = join(folder, basename(requested));
  if (((await stat(folder)).mode & 0o077) !== 0) throw new Error("Private directory required");
  while (true) {
    try {
      await stat(join(folder, ".git"));
      throw new Error("Git directory refused");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  await writeFile(full, `${JSON.stringify(configuration.parse(credentials))}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

export async function sendProbe({ origin, credentials, token, send = fetch }) {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".workers.dev") ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new Error("Worker origin required");
  const config = configuration.parse(credentials);
  const remaining = Date.parse(config.PROBE_EXPIRES_AT) - Date.now();
  if (remaining <= 0 || remaining > 15 * 60 * 1000) throw new Error("Expired credentials");
  if (typeof token !== "string" || !/^(?:[0-9a-f]{2}){16,128}$/.test(token))
    throw new Error("Invalid token");
  const response = await send(new URL("/probe", url), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${config.PROBE_AUTH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_token: token }),
  });
  if (!response.ok || !response.body) throw new Error("Probe rejected");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 2048) throw new Error("Invalid evidence");
      chunks.push(chunk.value);
    }
    return evidence.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel();
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "private-key": { type: "string" },
      "key-id": { type: "string" },
      "team-id": { type: "string" },
      out: { type: "string" },
      origin: { type: "string" },
      credentials: { type: "string" },
      "token-file": { type: "string" },
    },
  });
  if (
    positionals[0] === "prepare" &&
    values["private-key"] &&
    values["key-id"] &&
    values["team-id"] &&
    values.out
  ) {
    const result = prepareCredentials({
      privateKey: await privateFile(values["private-key"]),
      keyId: values["key-id"],
      teamId: values["team-id"],
    });
    await saveCredentials(values.out, result);
    process.stdout.write(
      "Prepared private credentials. Probe window: 10 minutes; APNs JWT: up to 1 hour.\n",
    );
  } else if (
    positionals[0] === "send" &&
    values.origin &&
    values.credentials &&
    values["token-file"]
  ) {
    const result = await sendProbe({
      origin: values.origin,
      credentials: JSON.parse(await privateFile(values.credentials)),
      token: JSON.parse(await privateFile(values["token-file"])).device_token,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.kind !== "apns_response" || result.status !== 200) process.exitCode = 1;
  } else {
    throw new Error("Invalid arguments");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write(
      "APNs probe command failed; no request or credential details were logged.\n",
    );
    process.exitCode = 1;
  });
}
