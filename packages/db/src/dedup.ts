import { lt } from "drizzle-orm";
import type { Db } from "./db";
import { deliveryDedup } from "./schema";
import { toDbTime } from "./time";

/** イベントを受け付ける。同じアカウントの同じ event_id を、すでに受け付けていれば false (送り手のやり直しで 2 回送らない)。 */
export async function acceptEventOnce(
  db: Db,
  input: { accountId: string; eventId: string },
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .insert(deliveryDedup)
    .values({ ...input, acceptedAt: toDbTime(now) })
    .onConflictDoNothing()
    .returning({ eventId: deliveryDedup.eventId });
  return rows.length > 0;
}

/** cutoff より前に受け付けた記録を消し、消した数を返す (定期の掃除で使う)。 */
export async function deleteAcceptedEventsBefore(db: Db, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(deliveryDedup)
    .where(lt(deliveryDedup.acceptedAt, toDbTime(cutoff)))
    .returning({ eventId: deliveryDedup.eventId });
  return rows.length;
}
