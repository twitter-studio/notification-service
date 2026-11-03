import type { ApnsEnvironment } from "@notification-service/db";
import type { OutgoingNotification } from "./payload";

// 端末へ通知を送る口 (設計書 §5 の PushGateway)。APNs へ送る部分は APNS-002 で作る。

export type PushTarget = {
  deviceId: string;
  /** 小文字の 16 進数のトークン。ログに出さない。 */
  apnsToken: string;
  apnsEnvironment: ApnsEnvironment;
  topic: string;
};

export type PushOutcome =
  /** APNs が受け付けた (端末に出た証明ではない)。 */
  | "sent"
  /** トークンが無効 (410 Unregistered、BadDeviceToken)。端末を止める。 */
  | "invalid_token"
  /** 少し待てば送れる (429、5xx)。送る側のやり直しで送れなかった。 */
  | "retry_later"
  /** 送れない (認証の誤りなど)。 */
  | "failed"
  /** APNs へ送る仕組みがまだない。 */
  | "not_configured";

/** `signal` は、送る時間の上限 (受け付けの記録のリースより短い)。送り手は、これで APNs への要求をやめる。 */
export type PushGateway = (
  target: PushTarget,
  notification: OutgoingNotification,
  options: { signal: AbortSignal },
) => Promise<PushOutcome>;

/** APNs へ送る仕組み (APNS-002) がまだないあいだの送り手。送らない。 */
export const notConfiguredPushGateway: PushGateway = async () => "not_configured";
