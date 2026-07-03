import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const a2aInvites = sqliteTable("a2a_invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  contactId: text("contact_id").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  useCount: integer("use_count").notNull().default(0),
  expiresAt: integer("expires_at").notNull(),
  status: text("status").notNull().default("active"),
  redeemedByExternalUserId: text("redeemed_by_external_user_id"),
  redeemedAt: integer("redeemed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const a2aTasks = sqliteTable("a2a_tasks", {
  id: text("id").primaryKey(),
  contextId: text("context_id"),
  conversationId: text("conversation_id"),
  state: text("state").notNull().default("submitted"),
  statusMessage: text("status_message"),
  requestMessageJson: text("request_message_json").notNull(),
  artifactsJson: text("artifacts_json"),
  pushUrl: text("push_url"),
  senderAssistantId: text("sender_assistant_id").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
