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
  importance: real('importance'),
  accessCount: integer('access_count').notNull().default(0),
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
  version: integer('version').notNull().default(1),
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

// ── Message Runs (approval flow) ─────────────────────────────────────

export const messageRuns = sqliteTable('message_runs', {
  id: text('id').primaryKey(),
  assistantId: text('assistant_id').notNull(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: text('message_id')
    .references(() => messages.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('running'),          // running | needs_confirmation | completed | failed
  pendingConfirmation: text('pending_confirmation'),            // JSON when status=needs_confirmation
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  estimatedCost: real('estimated_cost').notNull().default(0),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const memoryCheckpoints = sqliteTable('memory_checkpoints', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ── Cron / Deferred Tasks ────────────────────────────────────────────

export const cronJobs = sqliteTable('cron_jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  cronExpression: text('cron_expression').notNull(),    // e.g. '0 9 * * 1-5'
  timezone: text('timezone'),                           // e.g. 'America/Los_Angeles'
  message: text('message').notNull(),
  nextRunAt: integer('next_run_at').notNull(),
  lastRunAt: integer('last_run_at'),
  lastStatus: text('last_status'),                     // 'ok' | 'error'
  retryCount: integer('retry_count').notNull().default(0),
  createdBy: text('created_by').notNull(),             // 'agent' | 'user'
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  service: text('service').notNull(),
  username: text('username'),
  email: text('email'),
  displayName: text('display_name'),
  status: text('status').notNull().default('active'),
  credentialRef: text('credential_ref'),
  metadataJson: text('metadata_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const cronRuns = sqliteTable('cron_runs', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => cronJobs.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),                    // 'ok' | 'error'
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  durationMs: integer('duration_ms'),
  output: text('output'),
  error: text('error'),
  conversationId: text('conversation_id'),
  createdAt: integer('created_at').notNull(),
});

// ── LLM Usage Events (cost tracking ledger) ─────────────────────────

// ── Entity Graph ─────────────────────────────────────────────────────

export const memoryEntities = sqliteTable('memory_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  aliases: text('aliases'),
  description: text('description'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  mentionCount: integer('mention_count').notNull().default(1),
});

export const memoryEntityRelations = sqliteTable('memory_entity_relations', {
  id: text('id').primaryKey(),
  sourceEntityId: text('source_entity_id').notNull(),
  targetEntityId: text('target_entity_id').notNull(),
  relation: text('relation').notNull(),
  evidence: text('evidence'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
});

export const memoryItemEntities = sqliteTable('memory_item_entities', {
  memoryItemId: text('memory_item_id').notNull(),
  entityId: text('entity_id').notNull(),
});

export const llmUsageEvents = sqliteTable('llm_usage_events', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  assistantId: text('assistant_id'),
  conversationId: text('conversation_id'),
  runId: text('run_id'),
  requestId: text('request_id'),
  actor: text('actor').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  cacheReadInputTokens: integer('cache_read_input_tokens'),
  estimatedCostUsd: real('estimated_cost_usd'),
  pricingStatus: text('pricing_status').notNull(),
  metadataJson: text('metadata_json'),
});
