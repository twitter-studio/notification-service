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
const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

// 外部キーは ON DELETE CASCADE にする。アカウントを消すとき (ADR-0001 §5)、子の行を順に消さずに、アカウントの行を消せば済むようにするため。

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
      .references(() => notificationAccounts.id, { onDelete: "cascade" }),
    // 登録をやり直したときに、同じ公開鍵で 2 つ目のアカウントを作らないよう、一意にする。
    publicKey: text("public_key").notNull().unique(),
    attestationState: text("attestation_state").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().default(now),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
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
      .references(() => installations.id, { onDelete: "cascade" }),
    apnsTokenCiphertext: text("apns_token_ciphertext").notNull(),
    tokenFingerprint: text("token_fingerprint").notNull(),
    apnsEnvironment: text("apns_environment", { enum: ["sandbox", "production"] }).notNull(),
    topic: text("topic").notNull(),
    // 利用者が止めたもの (disabled_by_user) と、APNs が無効と返したもの (invalidated) を分ける。
    // トークンを登録し直したときに、前者は止めたまま、後者は有効に戻すため。
    state: text("state", { enum: ["active", "disabled_by_user", "invalidated"] })
      .notNull()
      .default("active"),
    updatedAt: timestamp("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("devices_token").on(t.tokenFingerprint, t.apnsEnvironment, t.topic),
    check("devices_apns_environment", sql`${t.apnsEnvironment} IN ('sandbox', 'production')`),
    check("devices_state", sql`${t.state} IN ('active', 'disabled_by_user', 'invalidated')`),
  ],
);

export const relayCredentials = sqliteTable(
  "relay_credentials",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => notificationAccounts.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull().unique(),
    createdAt: timestamp("created_at").notNull().default(now),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    lastUsedAt: timestamp("last_used_at"),
  },
  (t) => [index("idx_relay_credentials_account").on(t.accountId)],
);

export const deliveryDedup = sqliteTable(
  "delivery_dedup",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => notificationAccounts.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    acceptedAt: timestamp("accepted_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.eventId] }),
    index("idx_delivery_dedup_accepted").on(t.acceptedAt),
  ],
);
