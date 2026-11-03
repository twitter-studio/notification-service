import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// 時刻は UNIX 時間のミリ秒の整数で持つ (Drizzle が Date に読み替える)。設計書の CURRENT_TIMESTAMP の文字列にしないのは、
// 形の違う時刻の文字列 ("YYYY-MM-DD HH:MM:SS" と ISO 8601) を比べると、期限の判定が最大 1 日ずれるため (ADR-0004)。
// 時刻はふつうアプリから渡す。既定の値は秒までにし、unixepoch('subsec') (SQLite 3.42 以降) に頼らない。
const now = sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

// 外部キーは ON DELETE CASCADE にしない。D1 で親の表を作り直す migration (DROP TABLE) が、CASCADE で子の行をすべて消すため
// (ADR-0004)。アカウントを消すときは、子の行から順に消す (account.ts)。

export const notificationAccounts = sqliteTable(
  "notification_accounts",
  {
    id: text("id").primaryKey(),
    state: text("state", { enum: ["active", "disabled", "deleted"] })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at").notNull().default(now),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    check("notification_accounts_state", sql`${t.state} IN ('active', 'disabled', 'deleted')`),
  ],
);

export const installations = sqliteTable(
  "installations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => notificationAccounts.id),
    // 登録をやり直したときに、同じ公開鍵で 2 つ目のアカウントを作らないよう、一意にする。
    publicKey: text("public_key").notNull().unique(),
    // 端末の確かめ (App Attest) の結果。値の意味は AUTH-001 で決める。
    attestationState: text("attestation_state", { enum: ["pending", "verified", "not_supported"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().default(now),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    check(
      "installations_attestation_state",
      sql`${t.attestationState} IN ('pending', 'verified', 'not_supported')`,
    ),
    index("idx_installations_account").on(t.accountId),
    // v1 は、1 つのアカウントに有効なインストールを 1 つだけ持つ (ADR-0001 §2)。
    uniqueIndex("installations_one_active_per_account")
      .on(t.accountId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    // 端末はインストールごとに 1 つ。トークンが変わったら、同じ行を書き換える。
    installationId: text("installation_id")
      .notNull()
      .unique()
      .references(() => installations.id),
    apnsTokenCiphertext: text("apns_token_ciphertext").notNull(),
    tokenFingerprint: text("token_fingerprint").notNull(),
    apnsEnvironment: text("apns_environment", { enum: ["sandbox", "production"] }).notNull(),
    topic: text("topic").notNull(),
    // 利用者が止めたもの (disabled_by_user) と、APNs が無効と返したもの (invalidated) を分ける。
    // トークンを登録し直したときに、前者は止めたまま、後者は有効に戻すため。
    state: text("state", { enum: ["active", "disabled_by_user", "invalidated"] })
      .notNull()
      .default("active"),
    // このトークンを持っていることを確かめた時刻。確かめるまで送らない (トークンを知っているだけの人の登録で送らないため)。
    // トークンが変わったら空に戻す。確かめ方は ADR-0008 (確かめの code を push で送り、アプリが返す)。
    verifiedAt: timestamp("verified_at"),
    updatedAt: timestamp("updated_at").notNull().default(now),
  },
  (t) => [
    // トークンを持っていることを確かめた行だけで、トークンを一意にする。確かめていない登録は何行あってもよく、どれにも送らない。
    // 登録だけで一意にすると、トークンを知っている人の登録が、本物の端末の登録や確かめを妨げられるため (ADR-0004)。
    uniqueIndex("devices_verified_token")
      .on(t.tokenFingerprint, t.apnsEnvironment, t.topic)
      .where(sql`${t.verifiedAt} IS NOT NULL`),
    index("idx_devices_token").on(t.tokenFingerprint, t.apnsEnvironment, t.topic),
    check("devices_apns_environment", sql`${t.apnsEnvironment} IN ('sandbox', 'production')`),
    // 平文のトークンを置かないよう、暗号文と指紋の形 (版の付いた形) を確かめる (ADR-0005)。
    check("devices_apns_token_ciphertext", sql`${t.apnsTokenCiphertext} GLOB 'v[0-9]*.*'`),
    check("devices_token_fingerprint", sql`${t.tokenFingerprint} GLOB 'f[0-9]*.*'`),
    check("devices_state", sql`${t.state} IN ('active', 'disabled_by_user', 'invalidated')`),
  ],
);

/**
 * 端末のトークンを持っていることの確かめ (ADR-0008)。確かめの code を push で送り、アプリが返したら、ここの記録と突き合わせて
 * 確かめたことにする。送ったときのトークン (指紋、環境、topic) を残し、その後にトークンが変わっていたら確かめない。
 * 端末ごとに 1 つ (送り直したら置き換える)。
 */
export const deviceVerifications = sqliteTable(
  "device_verifications",
  {
    deviceId: text("device_id")
      .primaryKey()
      .references(() => devices.id),
    codeHash: text("code_hash").notNull(),
    tokenFingerprint: text("token_fingerprint").notNull(),
    apnsEnvironment: text("apns_environment", { enum: ["sandbox", "production"] }).notNull(),
    topic: text("topic").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().default(now),
  },
  (t) => [
    index("idx_device_verifications_expires").on(t.expiresAt),
    // code の SHA-256 の Base64URL (43 文字) だけを置く。
    check(
      "device_verifications_code_hash",
      sql`length(${t.codeHash}) = 43 AND ${t.codeHash} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
  ],
);

export const relayCredentials = sqliteTable(
  "relay_credentials",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => notificationAccounts.id),
    secretHash: text("secret_hash").notNull().unique(),
    createdAt: timestamp("created_at").notNull().default(now),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [
    index("idx_relay_credentials_account").on(t.accountId, t.createdAt),
    index("idx_relay_credentials_revoked").on(t.revokedAt),
    // SHA-256 の Base64URL (43 文字) だけを置く。平文のトークン (`tsr_` と 43 文字) を置かせない。
    check(
      "relay_credentials_secret_hash",
      sql`length(${t.secretHash}) = 43 AND ${t.secretHash} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
  ],
);

export const deliveryDedup = sqliteTable(
  "delivery_dedup",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => notificationAccounts.id),
    // 送り手の event_id の SHA-256 (Base64URL)。event_id に X の ID などが入りうるので、生の値を DB に置かない (ADR-0009)。
    eventKey: text("event_key").notNull(),
    acceptedAt: timestamp("accepted_at").notNull().default(now),
    // 送る処理の途中 (processing) か、済んだ (done) か。処理中のやり直しを、済んだ重複と分けて答えるため (ADR-0009)。
    state: text("state", { enum: ["processing", "done"] })
      .notNull()
      .default("processing"),
    // 状態を最後に書いた時刻。処理中のまま止まった記録 (Worker が途中で落ちた) を、やり直しで引き継ぐのに使う。
    updatedAt: timestamp("updated_at").notNull().default(now),
    // 受け付けと引き継ぎのたびに変える乱数の印。済みにする・消すのは、今の印を持つ要求だけにする (引き継がれた前の要求に触らせない)。
    leaseId: text("lease_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.eventKey] }),
    // アカウントごとの 1 日の受け付けの数を数える。定期の掃除 (受け付けた時刻で消す) は、表を読んで探す (索引を増やすと、
    // 受け付けのたびの書き込みが増えるため)。
    index("idx_delivery_dedup_account_accepted").on(t.accountId, t.acceptedAt),
    check("delivery_dedup_state", sql`${t.state} IN ('processing', 'done')`),
  ],
);

/**
 * 使ったチャレンジ (登録やセッションの作り直しで、署名したもの)。同じチャレンジを 2 回使わせないため。
 * チャレンジそのものはサーバーの秘密で署名した値で、出すときには DB に書かない (名前を名乗らない呼び出しで書き込みを使わせない)。
 * 使ったときだけここに書き、期限を過ぎたら定期の掃除で消す (ADR-0006)。
 */
export const usedChallenges = sqliteTable(
  "used_challenges",
  {
    nonce: text("nonce").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("idx_used_challenges_expires").on(t.expiresAt)],
);

/** アカウントのセッション (短命の bearer)。DB にはハッシュだけを置く (ADR-0006)。 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => notificationAccounts.id),
    installationId: text("installation_id")
      .notNull()
      .references(() => installations.id),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at").notNull().default(now),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    // SHA-256 の Base64URL (43 文字) だけを置く。平文のトークン (`tss_` と 43 文字) を置かせない。
    check(
      "sessions_token_hash",
      sql`length(${t.tokenHash}) = 43 AND ${t.tokenHash} NOT GLOB '*[^A-Za-z0-9_-]*'`,
    ),
    index("idx_sessions_account").on(t.accountId),
    // インストールの取り消しと、インストールごとのセッションの数の上限 (新しい順に残す) で引く。
    index("idx_sessions_installation").on(t.installationId, t.createdAt),
    index("idx_sessions_expires").on(t.expiresAt),
  ],
);
