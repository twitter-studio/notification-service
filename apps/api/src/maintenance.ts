import {
  createDb,
  deleteAcceptedEventsBefore,
  deleteExpiredAuthRecords,
  deleteRevokedRelayCredentials,
} from "@notification-service/db";
import { CLOCK_SKEW_MS } from "./security/challenge";

/**
 * 受け付けの記録 (重複の除去) を残す期間。送り手 (利用者の Worker) がやり直す期間より長くする。
 * 短くすると、遅れて届いたやり直しを、新しいイベントとして 2 回送ってしまうため。
 * これより古いイベントは、受け付けるときに、イベントの時刻の新しさで拒む (API-003、ADR-0005)。
 */
export const ACCEPTED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 取り消した中継の資格情報を残す期間。入れ替えの上限 (1 時間あたり) を数えるのに使うので、それより長くする。 */
export const REVOKED_RELAY_CREDENTIAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 1 回に消す件数 (`batch`) と、1 回の掃除でくり返す上限 (`maxBatches`)。残りは次の掃除で消す。 */
export type CleanupLimits = { batch: number; maxBatches: number };

const DEFAULT_LIMITS: CleanupLimits = { batch: 500, maxBatches: 20 };

export type CleanupResult = {
  deleted: number;
  /** 上限まで消したとき (まだ残っていうる)。続くなら、Cron の間隔を短くする。 */
  capped: boolean;
};

/** 定期の掃除 (Cron)。残す期間より古い受け付けの記録を、件数を区切って消す。 */
export async function cleanupAcceptedEvents(
  env: Env,
  scheduledTime: number,
  limits = DEFAULT_LIMITS,
): Promise<CleanupResult> {
  const db = createDb(env.DB);
  const cutoff = new Date(scheduledTime - ACCEPTED_EVENT_RETENTION_MS);
  let deleted = 0;
  for (let batch = 0; batch < limits.maxBatches; batch++) {
    const count = await deleteAcceptedEventsBefore(db, cutoff, limits.batch);
    deleted += count;
    if (count < limits.batch) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}

/**
 * 定期の掃除 (Cron)。期限を過ぎた使ったチャレンジとセッションの記録と、取り消してから残す期間を過ぎた中継の資格情報を、
 * 件数を区切って消す。
 * 期限から時計のずれの幅を過ぎたものだけを消す。時計の遅れたサーバーがまだ受けるチャレンジの記録を消すと、使い回せてしまう。
 */
export async function cleanupExpiredAuthRecords(
  env: Env,
  scheduledTime: number,
  limits = DEFAULT_LIMITS,
): Promise<CleanupResult> {
  const db = createDb(env.DB);
  const cutoff = new Date(scheduledTime - CLOCK_SKEW_MS);
  const revokedBefore = new Date(scheduledTime - REVOKED_RELAY_CREDENTIAL_RETENTION_MS);
  let deleted = 0;
  for (let batch = 0; batch < limits.maxBatches; batch++) {
    const { challenges, sessions } = await deleteExpiredAuthRecords(db, cutoff, limits.batch);
    const credentials = await deleteRevokedRelayCredentials(db, revokedBefore, limits.batch);
    deleted += challenges + sessions + credentials;
    // どの表も、区切りの件数より少なければ、消し残しはない。
    if (challenges < limits.batch && sessions < limits.batch && credentials < limits.batch)
      return { deleted, capped: false };
  }
  return { deleted, capped: true };
}
