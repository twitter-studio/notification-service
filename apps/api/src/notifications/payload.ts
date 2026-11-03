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

/** 端末へ送る通知。APNs へ送る仕組み (APNS-002) が、`payload` を本文にして送る。 */
export type OutgoingNotification = {
  /** 同じイベントの通知をまとめる (APNs の apns-collapse-id に使う。長さは送る側で合わせる)。 */
  eventId: string;
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
