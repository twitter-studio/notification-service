import {
  createDb,
  findActiveInstallation,
  invalidateDevice,
  isRelayCredentialActive,
  listActiveDevices,
} from "@notification-service/db";
import { z } from "zod";
import { DEVICE_VERIFICATION_TTL_MS, type DeviceVerificationSender } from "../devices/verification";
import { EVENT_TYPES } from "../notifications/payload";
import type { PushGateway } from "../notifications/push";
import { loadDeviceTokenKeys, openDeviceToken } from "../security/device-token";
import { recordTelemetry } from "../telemetry";
import { ApnsClient, type ApnsResult } from "./client";

const RETENTION_MS = 60 * 60 * 1000;
const MAX_QUEUE_ATTEMPTS = 2;
const Payload = z.strictObject({
  aps: z.strictObject({
    alert: z.strictObject({ "loc-key": z.literal("You have a new notification.") }),
    sound: z.literal("default"),
  }),
  event_type: z.enum([...EVENT_TYPES, "test"]),
  post_id: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .optional(),
});
const RetryJob = z.strictObject({
  accountId: z.uuid(),
  authority: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("relay"), credentialId: z.uuid() }),
    z.strictObject({ kind: z.literal("installation"), installationId: z.uuid() }),
  ]),
  deviceId: z.uuid(),
  fingerprint: z.string().regex(/^f1\.[A-Za-z0-9_-]{43}$/),
  environment: z.enum(["sandbox", "production"]),
  topic: z.string().max(255),
  eventKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  apnsId: z.uuid(),
  expiresAt: z.number().int().nonnegative(),
  payload: Payload,
});

type Job = z.infer<typeof RetryJob>;

/** jitter は基準の0〜10%。5xx は15分より短くしない。 */
export function retryDelay(base: number, attempt: number, random = Math.random): number {
  const exponential = Math.min(1800, base * 2 ** Math.max(0, attempt - 1));
  return exponential + Math.floor(exponential * 0.1 * random());
}

type GatewayEnv = Pick<
  Env,
  | "DB"
  | "APNS_RETRIES"
  | "APNS_PROVIDER_KEYS"
  | "DEVICE_TOKEN_KEYS"
  | "DEVICE_TOKEN_FINGERPRINT_KEY"
  | "DEVICE_TOKEN_KEY_CHECKS"
>;

export class ApnsPushGateway {
  readonly push: PushGateway;
  readonly sendDeviceVerification: DeviceVerificationSender;
  private readonly client: ApnsClient;
  private readonly now: () => number;
  private readonly queue: Pick<Queue, "send">;

  constructor(
    private readonly env: GatewayEnv,
    options: {
      send?: typeof fetch;
      now?: () => number;
      queue?: Pick<Queue, "send">;
      client?: ApnsClient;
    } = {},
  ) {
    this.client = options.client ?? new ApnsClient(env.APNS_PROVIDER_KEYS, options);
    this.now = options.now ?? Date.now;
    this.queue = options.queue ?? env.APNS_RETRIES;
    this.push = async (target, notification, { signal }) => {
      const apnsId = crypto.randomUUID();
      const expiresAt = this.now() + RETENTION_MS;
      const result = await this.client.deliver({
        target,
        payload: notification.payload,
        pushType: "alert",
        id: apnsId,
        expiresAt,
        collapseId: notification.eventKey,
        signal,
      });
      if (result.kind !== "retry") return result;
      const job: Job = {
        accountId: target.accountId,
        authority: target.authority,
        deviceId: target.deviceId,
        fingerprint: target.tokenFingerprint,
        environment: target.apnsEnvironment,
        topic: target.topic,
        eventKey: notification.eventKey,
        apnsId,
        expiresAt,
        payload: notification.payload,
      };
      // 平文トークン、署名鍵、検証 code は Queue に置かない。再送時に D1 の最新の状態と照合する。
      const delay = retryDelay(result.delaySeconds, 1);
      await this.queue.send(job, { delaySeconds: delay });
      recordTelemetry({
        event: "delivery_retry",
        stage: "queued",
        attempt: 1,
        delay_seconds: delay,
      });
      return { kind: "queued" };
    };
    this.sendDeviceVerification = async (push) => {
      const result = await this.client.deliver({
        target: push,
        pushType: "background",
        id: crypto.randomUUID(),
        expiresAt: this.now() + DEVICE_VERIFICATION_TTL_MS,
        signal: AbortSignal.timeout(10_000),
        payload: {
          aps: { "content-available": 1 },
          verification: { device_id: push.deviceId, code: push.code },
        },
      });
      if (result.kind === "invalid_token")
        await invalidateDevice(createDb(this.env.DB), {
          deviceId: push.deviceId,
          tokenFingerprint: push.tokenFingerprint,
          registrationCiphertext: push.registrationCiphertext,
          invalidatedBefore: new Date(result.invalidatedBefore),
          apnsEnvironment: push.apnsEnvironment,
          topic: push.topic,
        });
      // 所有確認は code の期限が10分。15分後の再送はせず、アプリの登録し直しで新しい code を発行する。
      return result.kind === "sent";
    };
  }

  async consume(batch: MessageBatch<unknown>, { allowRelay = true } = {}): Promise<void> {
    for (const message of batch.messages) {
      let result: ApnsResult;
      try {
        if (message.attempts > MAX_QUEUE_ATTEMPTS) {
          recordTelemetry({ event: "delivery_discarded", reason: "attempt_limit" });
          message.ack();
          continue;
        }
        const parsed = RetryJob.safeParse(message.body);
        if (!parsed.success) {
          recordTelemetry({ event: "delivery_discarded", reason: "invalid_job" });
          console.error(JSON.stringify({ event: "apns_retry_invalid_job" }));
          message.ack();
          continue;
        }
        const job = parsed.data;
        if (!allowRelay && job.authority.kind === "relay") {
          recordTelemetry({ event: "delivery_discarded", reason: "operations_paused" });
          message.ack();
          continue;
        }
        if (job.expiresAt <= this.now() || job.expiresAt > this.now() + RETENTION_MS) {
          recordTelemetry({ event: "delivery_discarded", reason: "expired" });
          message.ack();
          continue;
        }
        const db = createDb(this.env.DB);
        const authority = job.authority;
        const authorized =
          authority.kind === "relay"
            ? await isRelayCredentialActive(
                db,
                { accountId: job.accountId, credentialId: authority.credentialId },
                new Date(this.now()),
              )
            : (await findActiveInstallation(db, authority.installationId))?.accountId ===
              job.accountId;
        if (!authorized) {
          recordTelemetry({ event: "delivery_discarded", reason: "unauthorized" });
          message.ack();
          continue;
        }
        const device = (await listActiveDevices(db, job.accountId)).find(
          (d) =>
            d.id === job.deviceId &&
            (authority.kind === "relay" || d.installationId === authority.installationId) &&
            d.tokenFingerprint === job.fingerprint &&
            d.apnsEnvironment === job.environment &&
            d.topic === job.topic,
        );
        // 削除、取り消し、通知停止、トークン更新後の古い仕事は送らない。
        if (device === undefined) {
          recordTelemetry({ event: "delivery_discarded", reason: "inactive_device" });
          message.ack();
          continue;
        }
        const keys = await loadDeviceTokenKeys(this.env);
        const apnsToken = await openDeviceToken(keys, {
          ciphertext: device.apnsTokenCiphertext,
          fingerprint: device.tokenFingerprint,
          installationId: device.installationId,
          apnsEnvironment: device.apnsEnvironment,
          topic: device.topic,
        });
        result = await this.client.deliver({
          target: { apnsToken, apnsEnvironment: device.apnsEnvironment, topic: device.topic },
          payload: job.payload,
          pushType: "alert",
          id: job.apnsId,
          expiresAt: job.expiresAt,
          collapseId: job.eventKey,
          signal: AbortSignal.timeout(10_000),
        });
        if (result.kind === "invalid_token")
          await invalidateDevice(db, {
            deviceId: device.id,
            registrationCiphertext: device.apnsTokenCiphertext,
            invalidatedBefore: new Date(result.invalidatedBefore),
            tokenFingerprint: device.tokenFingerprint,
            apnsEnvironment: device.apnsEnvironment,
            topic: device.topic,
          });
      } catch {
        // Queue の元の例外や本文はログに出さない。鍵の設定や D1 の一時障害も回数を制限する。
        result = { kind: "retry", delaySeconds: 900 };
      }
      if (result.kind === "retry" && message.attempts < MAX_QUEUE_ATTEMPTS) {
        const delay = retryDelay(result.delaySeconds, message.attempts + 1);
        message.retry({ delaySeconds: delay });
        recordTelemetry({
          event: "delivery_retry",
          stage: "requeued",
          attempt: message.attempts + 1,
          delay_seconds: delay,
        });
      } else {
        if (result.kind !== "sent" && result.kind !== "invalid_token")
          console.error(JSON.stringify({ event: "apns_delivery_exhausted", outcome: result.kind }));
        message.ack();
      }
    }
  }
}
