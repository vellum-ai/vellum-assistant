import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { contacts } from "./contacts.js";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  template: text("template").notNull(),
  inputSchema: text("input_schema"),
  contextFlags: text("context_flags"),
  requiredTools: text("required_tools"),
  createdFromConversationId: text("created_from_conversation_id"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const taskRuns = sqliteTable("task_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id"),
  status: text("status").notNull().default("pending"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  error: text("error"),
  principalId: text("principal_id"),
  createdAt: integer("created_at").notNull(),
});

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
