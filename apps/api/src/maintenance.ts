import {
  createDb,
  deleteAcceptedEventsBefore,
  deleteExpiredAuthRecords,
  deleteExpiredDeviceVerifications,
  deleteRevokedRelayCredentials,
  deleteStaleDevices,
} from "@notification-service/db";
import { CLOCK_SKEW_MS } from "./security/challenge";

/**
 * 受け付けの記録 (重複の除去) を残す期間。送り手 (利用者の Worker) がやり直す期間より長くする。
 * 短くすると、遅れて届いたやり直しを、新しいイベントとして 2 回送ってしまうため。
 * これより古いイベントは、受け付けるときに、イベントの時刻の新しさで拒む (ADR-0005、ADR-0009)。
 */
export const ACCEPTED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 定期の掃除の間隔 (wrangler.jsonc の Cron、1 日 1 回)。受け付けるイベントの古さの上限を決めるのに使う。 */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 取り消した中継の資格情報を残す期間。入れ替えの上限 (1 時間あたり) を数えるのに使うので、それより長くする。 */
export const REVOKED_RELAY_CREDENTIAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** APNs が無効と返した端末の行を残す期間。同じインストールが登録し直せば戻るので、少しのあいだは残す。 */
export const INVALIDATED_DEVICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 確かめていない端末の行を残す期間。アプリは起動のたびに登録し直すので、使っている端末なら、この間に書き換わる。 */
export const UNVERIFIED_DEVICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 1 回に消す件数 (`batch`) と、1 回の掃除でくり返す上限 (`maxBatches`)。残りは次の掃除で消す。 */
export type CleanupLimits = { batch: number; maxBatches: number };

/** 1 回の掃除で消せるのは、表ごとに 5 万件まで。受け付けの上限 (アカウントごとに 1 日 1,000 件。ADR-0009) の 50 アカウント分。 */
const DEFAULT_LIMITS: CleanupLimits = { batch: 500, maxBatches: 100 };

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
 * 定期の掃除 (Cron)。期限を過ぎた使ったチャレンジ、セッション、端末の確かめの記録と、取り消してから残す期間を過ぎた中継の
 * 資格情報を、件数を区切って消す。
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
    const verifications = await deleteExpiredDeviceVerifications(db, cutoff, limits.batch);
    deleted += challenges + sessions + credentials + verifications;
    // どの表も、区切りの件数より少なければ、消し残しはない。
    if ([challenges, sessions, credentials, verifications].every((count) => count < limits.batch))
      return { deleted, capped: false };
  }
  return { deleted, capped: true };
}

/**
 * 定期の掃除 (Cron)。使わなくなった端末の行 (APNs が無効と返したもの、確かめないまま書き換わっていないもの) を、件数を区切って消す
 * (ADR-0004)。利用者が止めた端末は消さない。
 */
export async function cleanupStaleDevices(
  env: Env,
  scheduledTime: number,
  limits = DEFAULT_LIMITS,
): Promise<CleanupResult> {
  const db = createDb(env.DB);
  const input = {
    invalidatedBefore: new Date(scheduledTime - INVALIDATED_DEVICE_RETENTION_MS),
    unverifiedBefore: new Date(scheduledTime - UNVERIFIED_DEVICE_RETENTION_MS),
  };
  let deleted = 0;
  let afterRowid = 0;
  for (let batch = 0; batch < limits.maxBatches; batch++) {
    const result = await deleteStaleDevices(db, { ...input, afterRowid }, limits.batch);
    deleted += result.deleted;
    afterRowid = result.lastRowid;
    // 選んだ数で決める (選んだ後に登録し直されて消さなかった行があっても、続きを探す)。
    if (result.selected < limits.batch) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}
