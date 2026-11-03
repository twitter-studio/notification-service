import { and, eq, lt } from "drizzle-orm";
import type { Db } from "./db";
import { deliveryDedup } from "./schema";

/**
 * イベントを受け付ける。同じアカウントの同じ event_id を、すでに受け付けていれば false (送り手のやり直しで 2 回送らない)。
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

/** cutoff より前に受け付けた記録を消し、消した数を返す (定期の掃除で使う)。消した行は返さない (多いと重くなるため)。 */
export async function deleteAcceptedEventsBefore(db: Db, cutoff: Date): Promise<number> {
  const result = await db.delete(deliveryDedup).where(lt(deliveryDedup.acceptedAt, cutoff)).run();
  return result.meta.changes;
}
