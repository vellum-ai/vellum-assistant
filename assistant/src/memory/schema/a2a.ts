import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
