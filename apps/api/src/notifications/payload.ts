import { z } from "zod";
import type { DeviceTokenKeys } from "../security/device-token";
import { fromBase64Url, toBase64Url } from "../security/encoding";

// 利用者の Worker から受け付けるイベントと、端末へ送る通知の中身 (ADR-0009)。

/** 受け付けるイベントの種類 (許可リスト)。送り手が決めた種類を、そのまま端末へ渡さない。 */
export const EVENT_TYPES = [
  "mention",
  "reply",
  "quote",
  "retweet",
  "like",
  "follow",
  "dm",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
/** 公開ツイートのプレビュー (と送った人の actor) を付けてよい種類。フォローと DM には付けない。 */
export const PREVIEW_EVENT_TYPES: ReadonlySet<EventType | "test"> = new Set([
  "mention",
  "reply",
  "quote",
  "retweet",
  "like",
]);

export const NotificationRouteID = z.uuid().brand<"NotificationRouteID">();
export type NotificationRouteID = z.infer<typeof NotificationRouteID>;

export const PreviewHandle = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);
export const PreviewExcerpt = z
  .string()
  .min(1)
  .max(280)
  .refine(
    (value) => value.trim() === value && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(value),
  );
/** 公開アカウントの表示名。題には出さず、通知拡張が送った人の名前に使う。 */
export const PreviewDisplayName = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => value.trim() === value && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(value),
  );
/** 公開アカウントのアイコン。通知拡張がこの URL から画像を取るので、X の画像の配信元の https の URL だけを受ける。 */
export const PreviewImage = z
  .string()
  .max(512)
  .refine((value) => {
    // 末尾が空の `?` や `#` も、クエリやフラグメントとして受けない。
    if (value.includes("?") || value.includes("#")) return false;
    try {
      const url = new URL(value);
      return (
        url.href === value &&
        url.protocol === "https:" &&
        url.hostname === "pbs.twimg.com" &&
        url.port === "" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname.startsWith("/profile_images/") &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  });
export const NotificationPreview = z.strictObject({
  author: PreviewHandle,
  excerpt: PreviewExcerpt,
  author_name: PreviewDisplayName.optional(),
  author_image: PreviewImage.optional(),
});
/** 通知拡張が Communication Notifications の送った人を作るための、公開アカウントの情報。 */
export const NotificationActor = z.strictObject({
  username: PreviewHandle,
  name: PreviewDisplayName.optional(),
  image: PreviewImage.optional(),
});
type NotificationPreview = z.infer<typeof NotificationPreview>;

export const DmPreviewEventID = z.string().regex(/^x2_[A-Za-z0-9_-]{43}$/);
export const SealedDmPreview = z
  .string()
  .min(39)
  .max(3400)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => fromBase64Url(value) !== undefined);
export const DmPreviewPayload = z.strictObject({
  event_id: DmPreviewEventID,
  sealed: SealedDmPreview,
});

export type RelayEvent = {
  eventId: string;
  type: EventType;
  /** ツイートの ID (数字だけ)。アプリは、これで X の決まった画面だけを開く。 */
  postId?: string | undefined;
  routeId?: NotificationRouteID | undefined;
  preview?: NotificationPreview | undefined;
  sealedDmPreview?: string | undefined;
};

/** ツイートを指さない種類。これらは `post_id` を受けない (ほかの種類は、`post_id` が要る)。 */
export const EVENT_TYPES_WITHOUT_POST: ReadonlySet<EventType> = new Set(["follow", "dm"]);

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

const NotificationMessage = z.enum([
  "You have a new notification.",
  "You have a new direct message.",
]);
export const DmPreviewFallbackAlert = z.strictObject({
  title: z.literal("Tweetbot"),
  "loc-key": z.literal("You have a new direct message."),
});
export const NotificationAlert = z.union([
  DmPreviewFallbackAlert,
  z.strictObject({ "loc-key": NotificationMessage }),
  z.strictObject({ title: z.string().regex(/^@[A-Za-z0-9_]{1,15}$/), body: PreviewExcerpt }),
]);

export type NotificationPayload = {
  aps: { alert: z.infer<typeof NotificationAlert>; sound: "default"; "mutable-content"?: 1 };
  event_type: EventType | "test";
  post_id?: string;
  route_id?: NotificationRouteID;
  dm_preview?: z.infer<typeof DmPreviewPayload>;
  actor?: z.infer<typeof NotificationActor>;
};

export function notificationPayload(event: RelayEvent): NotificationPayload {
  const preview = PREVIEW_EVENT_TYPES.has(event.type) ? event.preview : undefined;
  const dmPreview =
    event.type === "dm" && event.routeId !== undefined && event.sealedDmPreview !== undefined
      ? { event_id: event.eventId, sealed: event.sealedDmPreview }
      : undefined;
  return {
    aps: {
      alert:
        dmPreview !== undefined
          ? { title: "Tweetbot", "loc-key": "You have a new direct message." }
          : preview === undefined
            ? {
                "loc-key":
                  event.type === "dm"
                    ? "You have a new direct message."
                    : "You have a new notification.",
              }
            : { title: `@${preview.author}`, body: preview.excerpt },
      sound: "default",
      // 通知拡張は、DM の暗号文を開くときと、プレビューの送った人で通知を作り直すときに動く。
      // 題と本文はそのまま残すので、通知拡張が動かなくても今までどおりに出る。
      ...(dmPreview === undefined && preview === undefined ? {} : { "mutable-content": 1 }),
    },
    event_type: event.type,
    ...(event.postId === undefined ? {} : { post_id: event.postId }),
    ...(event.routeId === undefined ? {} : { route_id: event.routeId }),
    ...(dmPreview === undefined ? {} : { dm_preview: dmPreview }),
    ...(preview === undefined
      ? {}
      : {
          actor: {
            username: preview.author,
            ...(preview.author_name === undefined ? {} : { name: preview.author_name }),
            ...(preview.author_image === undefined ? {} : { image: preview.author_image }),
          },
        }),
  };
}
