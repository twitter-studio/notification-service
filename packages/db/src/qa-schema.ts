import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export * from "./schema";

export const qaCampaign = sqliteTable("qa_campaign", {
  singleton: integer("singleton").primaryKey(),
  startedAt: integer("started_at").notNull(),
});
export const qaCases = sqliteTable("qa_cases", {
  name: text("name").primaryKey(),
  accountId: text("account_id").notNull(),
  installationId: text("installation_id").notNull(),
  deviceId: text("device_id").notNull(),
  credentialId: text("credential_id").notNull(),
});
export const qaAttempts = sqliteTable("qa_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: integer("status").notNull(),
  startedAt: integer("started_at").notNull(),
  jwtIssuedAt: integer("jwt_issued_at").notNull(),
  isolateId: text("isolate_id").notNull(),
});
