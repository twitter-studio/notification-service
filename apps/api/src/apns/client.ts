import { z } from "zod";
import type { PushTarget } from "../notifications/push";
import { toBase64Url } from "../security/encoding";

const SigningKey = z.strictObject({
  environment: z.enum(["sandbox", "production"]),
  topic: z.string().regex(/^[A-Za-z0-9.-]{1,255}$/),
  key_id: z.string().regex(/^[A-Z0-9]{10}$/),
  team_id: z.string().regex(/^[A-Z0-9]{10}$/),
  private_key: z.string().min(1).max(4096),
});
const Keys = z.array(SigningKey).max(8);
const Reason = z.object({
  reason: z.string().max(128),
  timestamp: z.number().int().nonnegative().optional(),
});
const HOSTS = { sandbox: "api.sandbox.push.apple.com", production: "api.push.apple.com" };
const REFRESH_MS = 50 * 60 * 1000;

export type ApnsResult =
  | { kind: "sent" }
  | { kind: "invalid_token"; invalidatedBefore: number }
  | { kind: "failed" }
  | { kind: "not_configured" }
  | { kind: "retry"; delaySeconds: number };

export type ApnsRequest = {
  target: Pick<PushTarget, "apnsToken" | "apnsEnvironment" | "topic">;
  payload: unknown;
  pushType: "alert" | "background";
  id: string;
  expiresAt: number;
  collapseId?: string;
  signal: AbortSignal;
};

type Provider = {
  configuration: z.infer<typeof SigningKey>;
  key?: Promise<CryptoKey>;
  token?: { issuedAt: number; value: Promise<string> };
};

/** APNS-001 の実機到達確認を根拠に、APNs の endpoint へ直接送る (ADR-0011)。 */
export class ApnsClient {
  private readonly providers: Provider[] | undefined;
  private readonly send: typeof fetch;
  private readonly now: () => number;

  constructor(json: string | undefined, options: { send?: typeof fetch; now?: () => number } = {}) {
    this.send = options.send ?? fetch;
    this.now = options.now ?? Date.now;
    try {
      const keys = Keys.parse(json === undefined || json.trim() === "" ? [] : JSON.parse(json));
      const scopes = new Set<string>();
      const ids = new Set<string>();
      for (const key of keys) {
        const scope = `${key.environment}:${key.topic}`;
        if (scopes.has(scope) || ids.has(key.key_id)) throw new Error();
        scopes.add(scope);
        ids.add(key.key_id);
      }
      this.providers = keys.map((configuration) => ({ configuration }));
    } catch {
      // Zod のエラーは入力 (秘密鍵) を含みうるので、外へ渡さない。
      this.providers = undefined;
    }
  }

  private async providerToken(provider: Provider): Promise<string> {
    const now = this.now();
    if (
      provider.token !== undefined &&
      now >= provider.token.issuedAt &&
      now - provider.token.issuedAt < REFRESH_MS
    )
      return provider.token.value;
    if (provider.token !== undefined && now < provider.token.issuedAt)
      throw new Error("apns_clock_invalid");
    const value = this.sign(provider, now);
    provider.token = { issuedAt: now, value };
    try {
      return await value;
    } catch {
      if (provider.token?.value === value) delete provider.token;
      throw new Error("apns_signing_failed");
    }
  }

  private async sign(provider: Provider, now: number): Promise<string> {
    const config = provider.configuration;
    provider.key ??= (async () => {
      const match =
        /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----\s*$/.exec(
          config.private_key,
        );
      if (match?.[1] === undefined) throw new Error();
      const bytes = Uint8Array.from(atob(match[1].replace(/\s/g, "")), (c) => c.charCodeAt(0));
      return crypto.subtle.importKey(
        "pkcs8",
        bytes,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
    })();
    const encode = (input: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(input)));
    const message =
      encode({ alg: "ES256", kid: config.key_id }) +
      "." +
      encode({ iss: config.team_id, iat: Math.floor(now / 1000) });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        await provider.key,
        new TextEncoder().encode(message),
      ),
    );
    if (signature.byteLength !== 64) throw new Error();
    return `${message}.${toBase64Url(signature)}`;
  }

  async deliver(request: ApnsRequest): Promise<ApnsResult> {
    if (this.providers === undefined) {
      console.error(JSON.stringify({ event: "apns_configuration_invalid" }));
      return { kind: "failed" };
    }
    const startedAt = this.now();
    const provider = this.providers.find(
      ({ configuration: c }) =>
        c.environment === request.target.apnsEnvironment && c.topic === request.target.topic,
    );
    if (provider === undefined) return { kind: "not_configured" };
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    if (signal.aborted) return { kind: "retry", delaySeconds: 60 };
    let token: string;
    try {
      token = await this.providerToken(provider);
    } catch {
      console.error(JSON.stringify({ event: "apns_signing_failed" }));
      return { kind: "failed" };
    }
    try {
      signal.throwIfAborted();
      const headers = new Headers({
        authorization: `bearer ${token}`,
        "apns-topic": request.target.topic,
        "apns-push-type": request.pushType,
        "apns-priority": request.pushType === "alert" ? "10" : "5",
        "apns-id": request.id,
        "apns-expiration": String(Math.floor(request.expiresAt / 1000)),
        "content-type": "application/json",
      });
      if (request.collapseId !== undefined) headers.set("apns-collapse-id", request.collapseId);
      const response = await this.send(
        "https://" +
          HOSTS[request.target.apnsEnvironment] +
          "/3/device/" +
          request.target.apnsToken,
        {
          method: "POST",
          redirect: "manual",
          headers,
          body: JSON.stringify(request.payload),
          signal,
        },
      );
      let errorBody: z.infer<typeof Reason> | undefined;
      if (response.status === 400 || response.status === 410) {
        errorBody = await readReason(response);
      } else {
        await response.body?.cancel();
      }
      if (response.status === 200) return { kind: "sent" };
      if (
        response.status === 410 &&
        errorBody?.reason === "Unregistered" &&
        errorBody.timestamp !== undefined
      )
        return {
          kind: "invalid_token",
          invalidatedBefore: Math.min(startedAt, errorBody.timestamp),
        };
      if (response.status === 400 && errorBody?.reason === "BadDeviceToken")
        return { kind: "invalid_token", invalidatedBefore: startedAt };
      if (response.status === 429) return { kind: "retry", delaySeconds: 60 };
      // Apple は 5xx の再試行に15分の待機を求める。HTTP 要求の中で短い間隔の再送をしない。
      if (response.status >= 500 && response.status <= 599)
        return { kind: "retry", delaySeconds: 900 };
      if (response.status === 403)
        console.error(JSON.stringify({ event: "apns_auth_failed", status: 403 }));
      return { kind: "failed" };
    } catch {
      // fetch の例外は送信先 URL (デバイストークン) を含みうる。文も元の例外も出さない。
      if (signal.aborted) return { kind: "retry", delaySeconds: 60 };
      console.error(JSON.stringify({ event: "apns_transport_or_signing_failed" }));
      return { kind: "retry", delaySeconds: 60 };
    }
  }
}

async function readReason(response: Response): Promise<z.infer<typeof Reason> | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > 1024) return undefined;
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = Reason.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
