import type {
  ApnsEnvironment,
  DeviceTokenCiphertext,
  DeviceTokenFingerprint,
} from "@notification-service/db";
import type { OutgoingNotification } from "./payload";

// 端末へ通知を送る口 (設計書 §5 の PushGateway)。

export type PushAuthority =
  | { kind: "relay"; credentialId: string }
  | { kind: "installation"; installationId: string };

export type PushTarget = {
  accountId: string;
  authority: PushAuthority;
  tokenFingerprint: DeviceTokenFingerprint;
  registrationCiphertext: DeviceTokenCiphertext;
  deviceId: string;
  /** 小文字の 16 進数のトークン。ログに出さない。 */
  apnsToken: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

export type PushOutcome =
  | { kind: "sent" }
  | { kind: "queued" }
  | { kind: "invalid_token"; invalidatedBefore: number }
  | { kind: "retry_later" }
  | { kind: "failed" }
  | { kind: "not_configured" };

/** `signal` は、送る時間の上限 (受け付けの記録のリースより短い)。送り手は、これで APNs への要求をやめる。 */
export type PushGateway = (
  target: PushTarget,
  notification: OutgoingNotification,
  options: { signal: AbortSignal },
) => Promise<PushOutcome>;

/** 注入のないテストや未設定の送り手。送らない。 */
export const notConfiguredPushGateway: PushGateway = async () => ({ kind: "not_configured" });
