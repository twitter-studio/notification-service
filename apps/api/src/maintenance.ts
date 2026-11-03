import {
  createDb,
  deleteAcceptedEventsBefore,
  deleteExpiredAuthRecords,
} from "@notification-service/db";

/**
 * 受け付けの記録 (重複の除去) を残す期間。送り手 (利用者の Worker) がやり直す期間より長くする。
 * 短くすると、遅れて届いたやり直しを、新しいイベントとして 2 回送ってしまうため。
 * これより古いイベントは、受け付けるときに、イベントの時刻の新しさで拒む (API-003、ADR-0005)。
 */
export const ACCEPTED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 1 回に消す件数と、1 回の掃除でくり返す上限。残りは次の掃除で消す。 */
const DELETE_BATCH = 500;
const MAX_BATCHES = 20;

export type CleanupResult = {
  deleted: number;
  /** 上限まで消したとき (まだ残っていうる)。続くなら、Cron の間隔を短くする。 */
  capped: boolean;
};

/** 定期の掃除 (Cron)。残す期間より古い受け付けの記録を、件数を区切って消す。 */
export async function cleanupAcceptedEvents(
  env: Env,
  scheduledTime: number,
): Promise<CleanupResult> {
  const db = createDb(env.DB);
  const cutoff = new Date(scheduledTime - ACCEPTED_EVENT_RETENTION_MS);
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const count = await deleteAcceptedEventsBefore(db, cutoff, DELETE_BATCH);
    deleted += count;
    if (count < DELETE_BATCH) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}

/** 定期の掃除 (Cron)。期限を過ぎた使ったチャレンジとセッションの記録を、件数を区切って消す。 */
export async function cleanupExpiredAuthRecords(
  env: Env,
  scheduledTime: number,
): Promise<CleanupResult> {
  const db = createDb(env.DB);
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { challenges, sessions } = await deleteExpiredAuthRecords(
      db,
      new Date(scheduledTime),
      DELETE_BATCH,
    );
    deleted += challenges + sessions;
    // どちらの表も、区切りの件数より少なければ、消し残しはない。
    if (challenges < DELETE_BATCH && sessions < DELETE_BATCH) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}
