import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { contacts } from "./contacts.js";

export const followups = sqliteTable("followups", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(), // 'email', 'slack', 'whatsapp', etc.
  conversationId: text("conversation_id").notNull(), // external conversation identifier
  contactId: text("contact_id").references(() => contacts.id, {
    onDelete: "set null",
  }),
  sentAt: integer("sent_at").notNull(), // epoch ms — when the outbound message was sent
  expectedResponseBy: integer("expected_response_by"), // epoch ms — deadline for expected reply
  status: text("status").notNull().default("pending"), // 'pending' | 'resolved' | 'overdue' | 'nudged'
  reminderCronId: text("reminder_cron_id"), // optional cron job ID for reminder
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
