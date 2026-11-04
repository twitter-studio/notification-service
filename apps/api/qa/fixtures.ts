import { createDb, invalidateDevice } from "@notification-service/db";
import { z } from "zod";
import { ApnsClient } from "../src/apns/client";
import { ApnsPushGateway } from "../src/apns/gateway";
import { hashBearerToken } from "../src/security/bearer";
import { loadDeviceTokenKeys, sealDeviceToken } from "../src/security/device-token";
import { fromBase64Url, toBase64Url } from "../src/security/encoding";

export type LabEnv = ConstructorParameters<typeof ApnsPushGateway>[0] & {
  QA_RATE_LIMITER: RateLimit;
  QA_ADMIN_TOKEN: string;
  QA_MODE: string;
  QA_DEADLINE: string;
};
export const TOPIC = "com.twitter-studio.NotificationQALab";
export const CASES = [
  "sent",
  "recover429",
  "exhaust503",
  "disabled",
  "revoked",
  "rotated",
  "bad-token400",
  "unregistered410",
] as const;
const isolateId = crypto.randomUUID();
let current: { configuration: string | undefined; client: ApnsClient } | undefined;

export function gateway(env: LabEnv) {
  if (current?.configuration !== env.APNS_PROVIDER_KEYS) {
    const send: typeof fetch = async (input, init) => {
      if (typeof input !== "string") throw new Error("qa_target_invalid");
      const url = new URL(input);
      if (
        url.origin !== "https://api.sandbox.push.apple.com" ||
        !/^\/3\/device\/[0-9a-f]{64}$/.test(url.pathname)
      )
        throw new Error("qa_target_invalid");
      const token = url.pathname.split("/").at(-1);
      const index = token === undefined ? -1 : Number.parseInt(token.slice(0, 2), 16) - 1;
      const name = CASES[index];
      if (name === undefined || new Headers(init?.headers).get("apns-topic") !== TOPIC)
        throw new Error("qa_target_invalid");
      const claimsPart = new Headers(init?.headers).get("authorization")?.split(".")[1];
      if (claimsPart === undefined) throw new Error("qa_jwt_invalid");
      const claims = z
        .object({ iss: z.literal("TESTTEAM01"), iat: z.int().nonnegative() })
        .parse(JSON.parse(new TextDecoder().decode(fromBase64Url(claimsPart))));
      const attempts = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM qa_attempts WHERE name=?",
      )
        .bind(name)
        .first<{ count: number }>();
      const count = attempts?.count ?? 0;
      const status =
        name === "sent"
          ? 200
          : name === "exhaust503"
            ? 503
            : name === "bad-token400"
              ? 400
              : name === "unregistered410"
                ? 410
                : count === 0
                  ? 429
                  : 200;
      await env.DB.prepare(
        "INSERT INTO qa_attempts(name,status,started_at,jwt_issued_at,isolate_id) VALUES(?,?,?,?,?)",
      )
        .bind(name, status, Date.now(), claims.iat, isolateId)
        .run();
      return status === 200
        ? new Response()
        : new Response(
            JSON.stringify({
              reason:
                status === 400
                  ? "BadDeviceToken"
                  : status === 410
                    ? "Unregistered"
                    : "SyntheticFailure",
              timestamp: Date.now(),
            }),
            { status },
          );
    };
    current = {
      configuration: env.APNS_PROVIDER_KEYS,
      client: new ApnsClient(env.APNS_PROVIDER_KEYS, { send }),
    };
  }
  return new ApnsPushGateway(env, { client: current.client });
}

export async function startCampaign(env: LabEnv) {
  // 本物の鍵の設定を誤って渡しても、QA用topicとラベルが違えば試験を始めない。
  const keys = z
    .array(
      z.object({
        environment: z.literal("sandbox"),
        topic: z.literal(TOPIC),
        key_id: z.literal("TESTKEY001"),
        team_id: z.literal("TESTTEAM01"),
      }),
    )
    .length(1)
    .safeParse(JSON.parse(env.APNS_PROVIDER_KEYS ?? "null"));
  if (!keys.success) throw new Error("qa_keys_invalid");
  const started = await env.DB.prepare(
    "INSERT OR IGNORE INTO qa_campaign(singleton,started_at) VALUES(1,?)",
  )
    .bind(Date.now())
    .run();
  if (started.meta.changes !== 1) return false;
  const cryptoKeys = await loadDeviceTokenKeys(env);
  const push = gateway(env).push;
  for (const [index, name] of CASES.entries()) {
    const account = crypto.randomUUID(),
      installation = crypto.randomUUID(),
      device = crypto.randomUUID(),
      credential = crypto.randomUUID();
    const prefix = (index + 1).toString(16).padStart(2, "0");
    const token =
      prefix +
      Array.from(crypto.getRandomValues(new Uint8Array(31)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const sealed = await sealDeviceToken(cryptoKeys, token, {
      installationId: installation,
      apnsEnvironment: "sandbox",
      topic: TOPIC,
    });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO notification_accounts(id,state) VALUES(?,'active')").bind(
        account,
      ),
      env.DB.prepare("INSERT INTO installations(id,account_id,public_key) VALUES(?,?,?)").bind(
        installation,
        account,
        `qa-synthetic-${installation}`,
      ),
      env.DB.prepare("INSERT INTO relay_credentials(id,account_id,secret_hash) VALUES(?,?,?)").bind(
        credential,
        account,
        await hashBearerToken(crypto.randomUUID()),
      ),
      env.DB.prepare(
        "INSERT INTO devices(id,installation_id,apns_token_ciphertext,token_fingerprint,apns_environment,topic,state,verified_at,updated_at) VALUES(?,?,?,?,'sandbox',?,'active',?,?)",
      ).bind(device, installation, sealed.ciphertext, sealed.fingerprint, TOPIC, now, now),
      env.DB.prepare(
        "INSERT INTO qa_cases(name,account_id,installation_id,device_id,credential_id) VALUES(?,?,?,?,?)",
      ).bind(name, account, installation, device, credential),
    ]);
    const result = await push(
      {
        accountId: account,
        authority: { kind: "relay", credentialId: credential },
        deviceId: device,
        registrationCiphertext: sealed.ciphertext,
        tokenFingerprint: sealed.fingerprint,
        apnsToken: token,
        apnsEnvironment: "sandbox",
        topic: TOPIC,
      },
      {
        eventKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
        payload: {
          aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
          event_type: "test",
        },
      },
      { signal: AbortSignal.timeout(10000) },
    );
    if (result.kind === "invalid_token")
      await invalidateDevice(createDb(env.DB), {
        deviceId: device,
        registrationCiphertext: sealed.ciphertext,
        tokenFingerprint: sealed.fingerprint,
        apnsEnvironment: "sandbox",
        topic: TOPIC,
        invalidatedBefore: new Date(result.invalidatedBefore),
      });
    if (name === "disabled")
      await env.DB.prepare("UPDATE devices SET state='disabled_by_user' WHERE id=?")
        .bind(device)
        .run();
    if (name === "revoked")
      await env.DB.prepare("UPDATE relay_credentials SET revoked_at=? WHERE id=?")
        .bind(Date.now(), credential)
        .run();
    if (name === "rotated") {
      const changed = await sealDeviceToken(cryptoKeys, "ff".repeat(32), {
        installationId: installation,
        apnsEnvironment: "sandbox",
        topic: TOPIC,
      });
      await env.DB.prepare(
        "UPDATE devices SET apns_token_ciphertext=?,token_fingerprint=?,updated_at=? WHERE id=?",
      )
        .bind(changed.ciphertext, changed.fingerprint, Date.now(), device)
        .run();
    }
    if (
      name === "recover429" ||
      name === "exhaust503" ||
      name === "disabled" ||
      name === "revoked" ||
      name === "rotated"
    ) {
      if (result.kind !== "queued") throw new Error("qa_initial_queue_failed");
    } else if (name === "sent" ? result.kind !== "sent" : result.kind !== "invalid_token")
      throw new Error("qa_initial_outcome_failed");
  }
  return true;
}

export async function campaignResults(env: LabEnv) {
  const attempts = await env.DB.prepare(
    "SELECT name,status,started_at,jwt_issued_at FROM qa_attempts ORDER BY id",
  ).all();
  const states = await env.DB.prepare(
    "SELECT q.name,d.state FROM qa_cases q JOIN devices d ON d.id=q.device_id ORDER BY q.name",
  ).all();
  const isolates = await env.DB.prepare(
    "SELECT COUNT(DISTINCT isolate_id) AS count FROM qa_attempts",
  ).first<{ count: number }>();
  return {
    attempts: attempts.results,
    states: states.results,
    isolate_count: isolates?.count ?? 0,
  };
}
