import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { deliveryDedup } from "./schema";

/** 処理中のまま、この時間より長く書き直していない記録は、止まったものとみなし、やり直しで引き継ぐ。 */
export const EVENT_PROCESSING_LEASE_MS = 2 * 60 * 1000;

export type EventStart =
  /** 受け付けた (初めて、または止まった処理中の記録を引き継いだ)。送ったら `completeEvent`、送れなかったら `releaseEvent`。 */
  | { kind: "accepted" }
  /** 同じイベントは、もう送った (送り手のやり直し)。 */
  | { kind: "done" }
  /** 同じイベントを、ほかの要求が送っている途中。少し待ってやり直してもらう。 */
  | { kind: "in_progress" };

/**
 * イベントを受け付ける。同じアカウントの同じ event_id は、1 回だけ受け付ける (送り手のやり直しで 2 回送らない)。
 * `now` にはサーバーの時刻を渡す。送り手のイベントの時刻 (`occurred_at`) を渡すと、記録を過去の日付にして早く消させられる。
 * 記録を残す期間より古いイベントは、ここに来る前に、イベントの時刻の新しさで拒む (ADR-0009)。
 * 記録を残す期間は、送り手がやり直す期間より長くする。
 */
export async function beginEvent(
  db: Db,
  input: { accountId: string; eventId: string },
  now = new Date(),
): Promise<EventStart> {
  // 新しい記録を置くか、止まった処理中の記録を引き継ぐ (1 文で行い、同時に来ても受け付けるのは 1 つだけ)。
  const taken = await db.$client
    .prepare(`
      INSERT INTO delivery_dedup (account_id, event_id, accepted_at, state, updated_at)
      VALUES (?1, ?2, ?3, 'processing', ?3)
      ON CONFLICT (account_id, event_id) DO UPDATE SET updated_at = excluded.updated_at
        WHERE delivery_dedup.state = 'processing' AND delivery_dedup.updated_at < ?4
      RETURNING state`)
    .bind(input.accountId, input.eventId, now.getTime(), now.getTime() - EVENT_PROCESSING_LEASE_MS)
    .first<{ state: string }>();
  if (taken !== null) return { kind: "accepted" };
  const existing = await db.$client
    .prepare("SELECT state FROM delivery_dedup WHERE account_id = ?1 AND event_id = ?2")
    .bind(input.accountId, input.eventId)
    .first<{ state: string }>();
  // 読むまでのあいだに記録が消えた (送れずに消した) ときも、やり直してもらう。
  return existing?.state === "done" ? { kind: "done" } : { kind: "in_progress" };
}

/** 送り終えた。以後の同じイベントは、済んだ重複として答える。 */
export async function completeEvent(
  db: Db,
  input: { accountId: string; eventId: string },
  now = new Date(),
): Promise<void> {
  await db
    .update(deliveryDedup)
    .set({ state: "done", updatedAt: now })
    .where(
      and(eq(deliveryDedup.accountId, input.accountId), eq(deliveryDedup.eventId, input.eventId)),
    );
}

/** 受け付けの記録を消す (受け付けたあとに送れなかったとき)。消したら true。 */
export async function releaseEvent(
  db: Db,
  input: { accountId: string; eventId: string },
): Promise<boolean> {
  const result = await db
    .delete(deliveryDedup)
    .where(
      and(eq(deliveryDedup.accountId, input.accountId), eq(deliveryDedup.eventId, input.eventId)),
    )
    .run();
  return result.meta.changes > 0;
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
      "DELETE FROM delivery_dedup WHERE rowid IN (SELECT rowid FROM delivery_dedup WHERE accepted_at < ?1 LIMIT ?2)",
    )
    .bind(cutoff.getTime(), limit)
    .run();
  return result.meta.changes;
}
