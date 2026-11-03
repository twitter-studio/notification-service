import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { deliveryDedup } from "./schema";

/**
 * イベントを受け付ける。同じアカウントの同じ event_id を、すでに受け付けていれば false (送り手のやり直しで 2 回送らない)。
 * `now` にはサーバーの時刻を渡す。送り手のイベントの時刻 (`occurred_at`) を渡すと、記録を過去の日付にして早く消させられる。
 * 記録を残す期間より古いイベントは、ここに来る前に、イベントの時刻の新しさで拒む (API-003)。
 * 受け付けたあとに送る処理が失敗したら、`releaseEvent` で記録を消し、送り手のやり直しを受け付けられるようにする。
 * 記録を残す期間は、送り手がやり直す期間より長くする。
 */
export async function acceptEventOnce(
  db: Db,
  input: { accountId: string; eventId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .insert(deliveryDedup)
    .values({ ...input, acceptedAt: now })
    .onConflictDoNothing()
    .returning({ eventId: deliveryDedup.eventId });
  return rows.length > 0;
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
