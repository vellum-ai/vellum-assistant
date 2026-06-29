import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  memoryScopeId: text("memory_scope_id"),
  createdAt: integer("created_at").notNull(),
});

export const taskCandidates = sqliteTable("task_candidates", {
  id: text("id").primaryKey(),
  sourceConversationId: text("source_conversation_id").notNull(),
  compiledTemplate: text("compiled_template").notNull(),
  confidence: real("confidence"),
  requiredTools: text("required_tools"), // JSON array string
  createdAt: integer("created_at").notNull(),
  promotedTaskId: text("promoted_task_id"), // set when candidate is promoted to a real task
});

export const workItems = sqliteTable("work_items", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  title: text("title").notNull(),
  notes: text("notes"),
  status: text("status").notNull().default("queued"), // queued | running | awaiting_review | failed | cancelled | done | archived
  priorityTier: integer("priority_tier").notNull().default(1), // 0=high, 1=medium, 2=low
  sortIndex: integer("sort_index"), // manual ordering within same priority tier; null = fall back to updated_at
  lastRunId: text("last_run_id"),
  lastRunConversationId: text("last_run_conversation_id"),
  lastRunStatus: text("last_run_status"), // 'completed' | 'failed' | null
  sourceType: text("source_type"), // reserved for future bridge (e.g. 'followup', 'triage')
  sourceId: text("source_id"), // reserved for future bridge
  requiredTools: text("required_tools"), // JSON array snapshot of tools needed for this run (null=unknown, []=none, ["bash",...]=specific)
  approvedTools: text("approved_tools"), // JSON array of pre-approved tool names
  approvalStatus: text("approval_status").default("none"), // 'none' | 'approved' | 'denied'
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
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
