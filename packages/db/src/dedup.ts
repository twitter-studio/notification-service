import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { deliveryDedup } from "./schema";

/** 処理中のまま、この時間より長く書き直していない記録は、止まったものとみなし、やり直しで引き継ぐ。 */
export const EVENT_PROCESSING_LEASE_MS = 2 * 60 * 1000;

/** イベントの記録の鍵。`eventKey` は、送り手の event_id のハッシュ (呼ぶ側が作る)。 */
export type EventRef = { accountId: string; eventKey: string };

export type EventStart =
  /**
   * 受け付けた (初めて、または止まった処理中の記録を引き継いだ)。送ったら `completeEvent`、送れなかったら `releaseEvent` を、
   * この `leaseId` で呼ぶ。
   */
  | { kind: "accepted"; leaseId: string }
  /** 同じイベントは、もう送った (送り手のやり直し)。 */
  | { kind: "done" }
  /** 同じイベントを、ほかの要求が送っている途中。少し待ってやり直してもらう。 */
  | { kind: "in_progress" };

/**
 * イベントを受け付ける。同じアカウントの同じイベントは、1 回だけ受け付ける (送り手のやり直しで 2 回送らない)。
 * `now` にはサーバーの時刻を渡す。送り手のイベントの時刻 (`occurred_at`) を渡すと、記録を過去の日付にして早く消させられる。
 * 記録を残す期間より古いイベントは、ここに来る前に、イベントの時刻の新しさで拒む (ADR-0009)。
 * 記録を残す期間は、送り手がやり直す期間より長くする。
 */
export async function beginEvent(db: Db, input: EventRef, now = new Date()): Promise<EventStart> {
  const leaseId = crypto.randomUUID();
  // 新しい記録を置くか、止まった処理中の記録を引き継ぐ (1 文で行い、同時に来ても受け付けるのは 1 つだけ)。
  const taken = await db.$client
    .prepare(`
      INSERT INTO delivery_dedup (account_id, event_key, accepted_at, state, updated_at, lease_id)
      VALUES (?1, ?2, ?3, 'processing', ?3, ?5)
      ON CONFLICT (account_id, event_key) DO UPDATE SET
        updated_at = excluded.updated_at, lease_id = excluded.lease_id
        WHERE delivery_dedup.state = 'processing' AND delivery_dedup.updated_at < ?4
      RETURNING lease_id`)
    .bind(
      input.accountId,
      input.eventKey,
      now.getTime(),
      now.getTime() - EVENT_PROCESSING_LEASE_MS,
      leaseId,
    )
    .first<{ lease_id: string }>();
  if (taken !== null) return { kind: "accepted", leaseId };
  const existing = await db.$client
    .prepare("SELECT state FROM delivery_dedup WHERE account_id = ?1 AND event_key = ?2")
    .bind(input.accountId, input.eventKey)
    .first<{ state: string }>();
  // 読むまでのあいだに記録が消えた (送れずに消した) ときも、やり直してもらう。
  return existing?.state === "done" ? { kind: "done" } : { kind: "in_progress" };
}

/**
 * 送り終えた。以後の同じイベントは、済んだ重複として答える。今の印を持つ処理中の記録だけを書き換え、書き換えたら true。
 * 引き継がれた後の前の要求は、何も変えない (引き継いだ要求が送る)。
 */
export async function completeEvent(
  db: Db,
  input: EventRef & { leaseId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(deliveryDedup)
    .set({ state: "done", updatedAt: now })
    .where(
      and(
        eq(deliveryDedup.accountId, input.accountId),
        eq(deliveryDedup.eventKey, input.eventKey),
        eq(deliveryDedup.leaseId, input.leaseId),
        eq(deliveryDedup.state, "processing"),
      ),
    )
    .returning({ eventKey: deliveryDedup.eventKey });
  return rows.length > 0;
}

/**
 * 受け付けの記録を消す (受け付けたあとに送れなかったとき)。今の印を持つ処理中の記録だけを消し、消したら true。
 * 引き継がれた記録や、済んだ記録は消さない (消すと、同じイベントをもう 1 回送ってしまう)。
 */
export async function releaseEvent(
  db: Db,
  input: EventRef & { leaseId: string },
): Promise<boolean> {
  const result = await db
    .delete(deliveryDedup)
    .where(
      and(
        eq(deliveryDedup.accountId, input.accountId),
        eq(deliveryDedup.eventKey, input.eventKey),
        eq(deliveryDedup.leaseId, input.leaseId),
        eq(deliveryDedup.state, "processing"),
      ),
    )
    .run();
  return result.meta.changes > 0;
}

/**
 * 受け付けの記録の今の状態 (主キーで 1 行だけ読む)。`new` は記録がない、`stale` は止まった処理中の記録 (引き継げる)。
 * 済んだ重複と処理中のやり直しを、1 日の上限より先に答えるのに使う。受け付けるかは、`beginEvent` が 1 文で決め直す。
 */
export async function findEventState(
  db: Db,
  input: EventRef,
  now = new Date(),
): Promise<"new" | "stale" | "done" | "in_progress"> {
  const row = await db.$client
    .prepare(
      "SELECT state, updated_at FROM delivery_dedup WHERE account_id = ?1 AND event_key = ?2",
    )
    .bind(input.accountId, input.eventKey)
    .first<{ state: string; updated_at: number }>();
  if (row === null) return "new";
  if (row.state === "done") return "done";
  return row.updated_at < now.getTime() - EVENT_PROCESSING_LEASE_MS ? "stale" : "in_progress";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC の 0 時 (D1 の無料のプランの枠が戻る時刻)。 */
export function utcDayStart(now: Date): Date {
  return new Date(now.getTime() - (now.getTime() % DAY_MS));
}

/**
 * アカウントの 1 日 (UTC の 0 時から) の受け付けの数を 1 つ増やす。日が変わっていたら、数え直す。上限に届いていたら増やさず false。
 * 1 文で行うので、同時に来ても上限を越えない。読むのも書くのも 1 行。数える日を D1 の枠の日 (UTC) にそろえ、1 つの日に
 * 上限の 2 日分が入らないようにする。
 */
export async function consumeDailyRelayQuota(
  db: Db,
  input: { accountId: string; limit: number },
  now = new Date(),
): Promise<boolean> {
  if (input.limit <= 0) return false;
  const row = await db.$client
    .prepare(`
      INSERT INTO relay_usage (account_id, window_start, count) VALUES (?1, ?2, 1)
      ON CONFLICT (account_id) DO UPDATE SET
        count = CASE WHEN relay_usage.window_start < ?2 THEN 1 ELSE relay_usage.count + 1 END,
        window_start = ?2
        WHERE relay_usage.window_start < ?2 OR relay_usage.count < ?3
      RETURNING count`)
    .bind(input.accountId, utcDayStart(now).getTime(), input.limit)
    .first<{ count: number }>();
  return row !== null;
}

/**
 * cutoff より前に受け付けた記録を、`limit` 件まで消し、消した数を返す (定期の掃除で、件数を区切ってくり返し呼ぶ)。
 * 1 文で全部消すと、量が多いときに D1 を長く占め、受け付けの処理を待たせるため。
 */
export async function deleteAcceptedEventsBefore(
  db: Db,
  cutoff: Date,
  limit = 500,
): Promise<number> {
  const result = await db.$client
    .prepare(
      // 索引 (アカウントの順) で読むと、区切りごとに前のアカウントの新しい行を読み直す。rowid の順 (ほぼ受け付けた順) に
      // 読めば、古い行から見つかる。
      "DELETE FROM delivery_dedup WHERE rowid IN (SELECT rowid FROM delivery_dedup NOT INDEXED WHERE accepted_at < ?1 LIMIT ?2)",
    )
    .bind(cutoff.getTime(), limit)
    .run();
  return result.meta.changes;
}
