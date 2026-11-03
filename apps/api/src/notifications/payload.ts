import type { DeviceTokenKeys } from "../security/device-token";
import { toBase64Url } from "../security/encoding";

// 利用者の Worker から受け付けるイベントと、端末へ送る通知の中身 (ADR-0009)。

/** 受け付けるイベントの種類 (許可リスト)。送り手が決めた種類を、そのまま端末へ渡さない。 */
export const EVENT_TYPES = ["mention", "reply", "quote", "retweet", "like", "follow"] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type RelayEvent = {
  eventId: string;
  type: EventType;
  /** ツイートの ID (数字だけ)。アプリは、これで X の決まった画面だけを開く。 */
  postId?: string | undefined;
};

/** ツイートを指さない種類。これらは `post_id` を受けない (ほかの種類は、`post_id` が要る)。 */
export const EVENT_TYPES_WITHOUT_POST: ReadonlySet<EventType> = new Set(["follow"]);

/**
 * 受け付けの記録の鍵。アカウントと送り手の event_id の HMAC-SHA256 (Base64URL、43 文字)。
 * event_id に X の ID などが入りうるので、生の値も、鍵のないハッシュ (推しやすい候補から確かめられる) も DB に置かない。
 * アカウントを入れて、同じ event_id でもアカウントごとに違う鍵にする (アカウントどうしを結び付けさせない)。
 * 鍵はデバイストークンの指紋の鍵 (入れ替えない。ADR-0005) を使い、頭の文で用途を分ける (指紋は 16 進数のトークンの HMAC)。
 * 長さが決まるので、APNs の apns-collapse-id (64 バイトまで) にも使える。
 */
export async function eventKeyOf(
  keys: DeviceTokenKeys,
  accountId: string,
  eventId: string,
): Promise<string> {
  const message = ["twitter-studio/event-key/v1", accountId, eventId].join("\n");
  return toBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", keys.fingerprintKey, new TextEncoder().encode(message)),
    ),
  );
}

/** 端末へ送る通知。APNs へ送る仕組み (APNS-002) が、`payload` を本文にして送る。 */
export type OutgoingNotification = {
  /** 同じイベントの通知をまとめる (APNs の apns-collapse-id に使う)。`eventKeyOf` の値。 */
  eventKey: string;
  payload: NotificationPayload;
};

export type NotificationPayload = {
  aps: { alert: { "loc-key": string }; sound: "default" };
  event_type: EventType;
  post_id?: string;
};

/**
 * 通知の中身。既定で中身を運ばない一般的な文にする (ADR-0001 §4)。文はアプリの訳 (loc-key) で出し、送り手の文や URL は
 * 入れない (送り手が、ほかのアプリや運営を装った文を出せないように)。アプリは `post_id` を確かめてから開く。
 */
export function notificationPayload(event: RelayEvent): NotificationPayload {
  return {
    aps: { alert: { "loc-key": "You have a new notification." }, sound: "default" },
    event_type: event.type,
    ...(event.postId === undefined ? {} : { post_id: event.postId }),
  };
}
