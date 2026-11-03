import { createDb, deleteAcceptedEventsBefore } from "@notification-service/db";

/**
 * 受け付けの記録 (重複の除去) を残す期間。送り手 (利用者の Worker) がやり直す期間 (1 日以内とする) より長くする。
 * 短くすると、遅れて届いたやり直しを、新しいイベントとして 2 回送ってしまうため。
 */
export const ACCEPTED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 定期の掃除 (Cron)。残す期間より古い受け付けの記録を消し、消した数を返す。 */
export async function cleanupAcceptedEvents(env: Env, scheduledTime: number): Promise<number> {
  return deleteAcceptedEventsBefore(
    createDb(env.DB),
    new Date(scheduledTime - ACCEPTED_EVENT_RETENTION_MS),
  );
}
