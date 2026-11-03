import {
  ABANDONED_ACCOUNT_AFTER_MS,
  createDb,
  deleteAbandonedAccount,
  deleteAcceptedEventsBefore,
  deleteExpiredAuthRecords,
  deleteExpiredDeviceVerifications,
  deleteRevokedRelayCredentials,
  deleteStaleDevices,
  findAbandonedAccounts,
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

/**
 * 1 回の Cron の呼び出しで D1 に投げる問い合わせの数の上限。無料のプランでは 1 回の呼び出しで 50 まで (バッチは 1 回と数える。
 * D1 の limits)。掃除ごとに Cron を分け (wrangler.jsonc)、それぞれをこの数の内側に収める。
 */
export const QUERY_BUDGET_PER_CLEANUP = 45;

/** 1 回に消す件数。D1 の 1 つの文の時間の上限 (30 秒) に十分に収まる。 */
const DELETE_BATCH = 1000;

/** 受け付けの記録: 1 回の区切りで 1 問い合わせ。1 日に 4.5 万件まで (アカウントごとの上限 1,000 件の 45 アカウント分。ADR-0009)。 */
const ACCEPTED_EVENT_LIMITS: CleanupLimits = {
  batch: DELETE_BATCH,
  maxBatches: QUERY_BUDGET_PER_CLEANUP,
};

/** チャレンジ、セッション、資格情報、確かめの記録: 1 回の区切りで 3 問い合わせ。 */
const AUTH_RECORD_LIMITS: CleanupLimits = {
  batch: DELETE_BATCH,
  maxBatches: Math.floor(QUERY_BUDGET_PER_CLEANUP / 3),
};

/** 端末: 1 回の区切りで 2 問い合わせ (選ぶ、消す)。 */
const STALE_DEVICE_LIMITS: CleanupLimits = {
  batch: DELETE_BATCH,
  maxBatches: Math.floor(QUERY_BUDGET_PER_CLEANUP / 2),
};

export type CleanupResult = {
  deleted: number;
  /** 上限まで消したとき (まだ残っていうる)。続くなら、Cron の間隔を短くする。 */
  capped: boolean;
};

/** 定期の掃除 (Cron)。残す期間より古い受け付けの記録を、件数を区切って消す。 */
export async function cleanupAcceptedEvents(
  env: Env,
  scheduledTime: number,
  limits = ACCEPTED_EVENT_LIMITS,
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
  limits = AUTH_RECORD_LIMITS,
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
  limits = STALE_DEVICE_LIMITS,
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

/**
 * 使われなくなったアカウントの掃除の大きさ。1 回で、探すのに 1 問い合わせ (`pageSize` 件ずつ)、1 アカウントを消すのに 1 問い合わせ。
 * 2 ページ (2 問い合わせ) と 40 アカウント (40 問い合わせ) で、問い合わせの上限の内側に収める。
 */
export type AbandonedCleanupLimits = { pageSize: number; maxAccounts: number };

const ABANDONED_ACCOUNT_LIMITS: AbandonedCleanupLimits = { pageSize: 20, maxAccounts: 40 };

/**
 * 定期の掃除 (Cron)。使われなくなったアカウントを消す (notification-service#20、ADR-0010)。消すのは `deleteAccount` と同じもの。
 * 消す直前にもう一度確かめる。1 つのアカウントで失敗しても、ログに出して次へ進む (毎日同じアカウントで止まり、後ろが消えなくならないよう)。
 */
export async function cleanupAbandonedAccounts(
  env: Env,
  scheduledTime: number,
  limits = ABANDONED_ACCOUNT_LIMITS,
): Promise<CleanupResult> {
  const db = createDb(env.DB);
  const since = new Date(scheduledTime - ABANDONED_ACCOUNT_AFTER_MS);
  const now = new Date(scheduledTime);
  let deleted = 0;
  let afterRowid = 0;
  let remaining = limits.maxAccounts;
  while (remaining > 0) {
    const pageSize = Math.min(remaining, limits.pageSize);
    const found = await findAbandonedAccounts(db, { since, afterRowid }, pageSize);
    for (const accountId of found.accountIds) {
      try {
        if (await deleteAbandonedAccount(db, { accountId, since }, now)) deleted++;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "abandoned_account_cleanup_failed",
            name: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
    remaining -= found.accountIds.length;
    afterRowid = found.lastRowid;
    if (found.accountIds.length < pageSize) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}
