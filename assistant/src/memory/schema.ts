import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  totalInputTokens: integer('total_input_tokens').notNull().default(0),
  totalOutputTokens: integer('total_output_tokens').notNull().default(0),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const toolInvocations = sqliteTable('tool_invocations', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  toolName: text('tool_name').notNull(),
  input: text('input').notNull(),
  result: text('result').notNull(),
  decision: text('decision').notNull(),
  riskLevel: text('risk_level').notNull(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: integer('created_at').notNull(),
});
