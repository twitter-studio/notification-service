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

// 時刻は UTC の ISO 8601 (ミリ秒まで、末尾 Z) の文字列で持つ。設計書の CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") にしないのは、
// アプリの Date#toISOString() と文字列のまま比べると、日付と時刻の区切り (' ' と 'T') が違って期限の判定がずれるため。
const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const notificationAccounts = sqliteTable(
  "notification_accounts",
  {
    id: text("id").primaryKey(),
    state: text("state", { enum: ["active", "disabled", "deleted"] })
      .notNull()
      .default("active"),
    createdAt: text("created_at").notNull().default(now),
    deletedAt: text("deleted_at"),
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
    publicKey: text("public_key").notNull(),
    attestationState: text("attestation_state").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(now),
    revokedAt: text("revoked_at"),
  },
  (t) => [index("idx_installations_account").on(t.accountId)],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => installations.id),
    apnsTokenCiphertext: text("apns_token_ciphertext").notNull(),
    tokenFingerprint: text("token_fingerprint").notNull(),
    apnsEnvironment: text("apns_environment", { enum: ["sandbox", "production"] }).notNull(),
    topic: text("topic").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("devices_token").on(t.tokenFingerprint, t.apnsEnvironment, t.topic),
    index("idx_devices_installation").on(t.installationId),
    check("devices_apns_environment", sql`${t.apnsEnvironment} IN ('sandbox', 'production')`),
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
    createdAt: text("created_at").notNull().default(now),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [index("idx_relay_credentials_account").on(t.accountId)],
);

export const deliveryDedup = sqliteTable(
  "delivery_dedup",
  {
    accountId: text("account_id").notNull(),
    eventId: text("event_id").notNull(),
    acceptedAt: text("accepted_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.eventId] }),
    index("idx_delivery_dedup_accepted").on(t.acceptedAt),
  ],
);
