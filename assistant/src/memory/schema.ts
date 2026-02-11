import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  totalInputTokens: integer('total_input_tokens').notNull().default(0),
  totalOutputTokens: integer('total_output_tokens').notNull().default(0),
  totalEstimatedCost: real('total_estimated_cost').notNull().default(0),
  contextSummary: text('context_summary'),
  contextCompactedMessageCount: integer('context_compacted_message_count').notNull().default(0),
  contextCompactedAt: integer('context_compacted_at'),
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
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id),
  toolName: text('tool_name').notNull(),
  input: text('input').notNull(),
  result: text('result').notNull(),
  decision: text('decision').notNull(),
  riskLevel: text('risk_level').notNull(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const memorySegments = sqliteTable('memory_segments', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  segmentIndex: integer('segment_index').notNull(),
  text: text('text').notNull(),
  tokenEstimate: integer('token_estimate').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const memoryItems = sqliteTable('memory_items', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  subject: text('subject').notNull(),
  statement: text('statement').notNull(),
  status: text('status').notNull(),
  confidence: real('confidence').notNull(),
  fingerprint: text('fingerprint').notNull(),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

export const memoryItemSources = sqliteTable('memory_item_sources', {
  memoryItemId: text('memory_item_id')
    .notNull()
    .references(() => memoryItems.id, { onDelete: 'cascade' }),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  evidence: text('evidence'),
  createdAt: integer('created_at').notNull(),
});

export const memorySummaries = sqliteTable('memory_summaries', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  scopeKey: text('scope_key').notNull(),
  summary: text('summary').notNull(),
  tokenEstimate: integer('token_estimate').notNull(),
  startAt: integer('start_at').notNull(),
  endAt: integer('end_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const memoryEmbeddings = sqliteTable('memory_embeddings', {
  id: text('id').primaryKey(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  vectorJson: text('vector_json').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const memoryJobs = sqliteTable('memory_jobs', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull().default(0),
  runAfter: integer('run_after').notNull(),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const conversationKeys = sqliteTable('conversation_keys', {
  id: text('id').primaryKey(),
  assistantId: text('assistant_id').notNull(),
  conversationKey: text('conversation_key').notNull(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
});

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  assistantId: text('assistant_id').notNull(),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  kind: text('kind').notNull(),
  dataBase64: text('data_base64').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const messageAttachments = sqliteTable('message_attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  attachmentId: text('attachment_id')
    .notNull()
    .references(() => attachments.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const channelInboundEvents = sqliteTable('channel_inbound_events', {
  id: text('id').primaryKey(),
  assistantId: text('assistant_id').notNull(),
  sourceChannel: text('source_channel').notNull(),
  externalChatId: text('external_chat_id').notNull(),
  externalMessageId: text('external_message_id').notNull(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: text('message_id')
    .references(() => messages.id, { onDelete: 'cascade' }),
  deliveryStatus: text('delivery_status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const memoryCheckpoints = sqliteTable('memory_checkpoints', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
