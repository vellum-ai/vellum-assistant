import { sqliteTable, text, integer, real, blob } from 'drizzle-orm/sqlite-core';

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
  threadType: text('thread_type').notNull().default('standard'),
  memoryScopeId: text('memory_scope_id').notNull().default('default'),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull(),
  metadata: text('metadata'),
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
  scopeId: text('scope_id').notNull().default('default'),
  contentHash: text('content_hash'),
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
  verificationState: text('verification_state').notNull().default('assistant_inferred'),
  scopeId: text('scope_id').notNull().default('default'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  validFrom: integer('valid_from'),
  invalidAt: integer('invalid_at'),
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

export const memoryItemConflicts = sqliteTable('memory_item_conflicts', {
  id: text('id').primaryKey(),
  scopeId: text('scope_id').notNull().default('default'),
  existingItemId: text('existing_item_id')
    .notNull()
    .references(() => memoryItems.id, { onDelete: 'cascade' }),
  candidateItemId: text('candidate_item_id')
    .notNull()
    .references(() => memoryItems.id, { onDelete: 'cascade' }),
  relationship: text('relationship').notNull(),
  status: text('status').notNull(),
  clarificationQuestion: text('clarification_question'),
  resolutionNote: text('resolution_note'),
  lastAskedAt: integer('last_asked_at'),
  resolvedAt: integer('resolved_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const memorySummaries = sqliteTable('memory_summaries', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  scopeKey: text('scope_key').notNull(),
  summary: text('summary').notNull(),
  tokenEstimate: integer('token_estimate').notNull(),
  version: integer('version').notNull().default(1),
  scopeId: text('scope_id').notNull().default('default'),
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
  deferrals: integer('deferrals').notNull().default(0),
  runAfter: integer('run_after').notNull(),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const conversationKeys = sqliteTable('conversation_keys', {
  id: text('id').primaryKey(),
  conversationKey: text('conversation_key').notNull(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
});

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  kind: text('kind').notNull(),
  dataBase64: text('data_base64').notNull(),
  contentHash: text('content_hash'),
  thumbnailBase64: text('thumbnail_base64'),
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
  sourceChannel: text('source_channel').notNull(),
  externalChatId: text('external_chat_id').notNull(),
  externalMessageId: text('external_message_id').notNull(),
  sourceMessageId: text('source_message_id'),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: text('message_id')
    .references(() => messages.id, { onDelete: 'cascade' }),
  deliveryStatus: text('delivery_status').notNull().default('pending'),
  processingStatus: text('processing_status').notNull().default('pending'),
  processingAttempts: integer('processing_attempts').notNull().default(0),
  lastProcessingError: text('last_processing_error'),
  retryAfter: integer('retry_after'),
  rawPayload: text('raw_payload'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ── Message Runs (approval flow) ─────────────────────────────────────

export const messageRuns = sqliteTable('message_runs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: text('message_id')
    .references(() => messages.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('running'),          // running | needs_confirmation | needs_secret | completed | failed
  pendingConfirmation: text('pending_confirmation'),            // JSON when status=needs_confirmation
  pendingSecret: text('pending_secret'),                        // JSON when status=needs_secret
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

// ── Reminders ────────────────────────────────────────────────────────

export const reminders = sqliteTable('reminders', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  message: text('message').notNull(),
  fireAt: integer('fire_at').notNull(),           // epoch ms, absolute timestamp
  mode: text('mode').notNull(),                   // 'notify' | 'execute'
  status: text('status').notNull(),               // 'pending' | 'firing' | 'fired' | 'cancelled'
  firedAt: integer('fired_at'),
  conversationId: text('conversation_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ── Recurrence Schedules ─────────────────────────────────────────────

export const cronJobs = sqliteTable('cron_jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  cronExpression: text('cron_expression').notNull(),    // e.g. '0 9 * * 1-5'
  scheduleSyntax: text('schedule_syntax').notNull().default('cron'),  // 'cron' | 'rrule'
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

// Recurrence-centric aliases — prefer these in new code.
// Physical table names remain `cron_jobs` / `cron_runs` for migration compatibility.
export const scheduleJobs = cronJobs;
export const scheduleRuns = cronRuns;

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

export const sharedAppLinks = sqliteTable('shared_app_links', {
  id: text('id').primaryKey(),
  shareToken: text('share_token').notNull().unique(),
  bundleData: blob('bundle_data', { mode: 'buffer' }).notNull(),
  bundleSizeBytes: integer('bundle_size_bytes').notNull(),
  manifestJson: text('manifest_json').notNull(),
  downloadCount: integer('download_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
});

// ── Contacts ─────────────────────────────────────────────────────────

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  relationship: text('relationship'),                  // e.g. 'colleague', 'friend', 'manager', 'client'
  importance: real('importance').notNull().default(0.5), // 0-1 scale, learned from interaction patterns
  responseExpectation: text('response_expectation'),    // e.g. 'immediate', 'within_hours', 'casual'
  preferredTone: text('preferred_tone'),                // e.g. 'formal', 'casual', 'friendly'
  lastInteraction: integer('last_interaction'),         // epoch ms
  interactionCount: integer('interaction_count').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const contactChannels = sqliteTable('contact_channels', {
  id: text('id').primaryKey(),
  contactId: text('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),                        // 'email', 'slack', 'whatsapp', 'phone', etc.
  address: text('address').notNull(),                  // the actual identifier on that channel
  isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

// ── Triage Results ───────────────────────────────────────────────────

export const triageResults = sqliteTable('triage_results', {
  id: text('id').primaryKey(),
  channel: text('channel').notNull(),
  sender: text('sender').notNull(),
  category: text('category').notNull(),
  confidence: real('confidence').notNull(),
  suggestedAction: text('suggested_action').notNull(),
  matchedPlaybookIds: text('matched_playbook_ids'),    // JSON array of playbook memory item IDs
  messageId: text('message_id'),                       // optional external message identifier
  createdAt: integer('created_at').notNull(),
});

// ── Follow-ups ──────────────────────────────────────────────────────

export const followups = sqliteTable('followups', {
  id: text('id').primaryKey(),
  channel: text('channel').notNull(),                     // 'email', 'slack', 'whatsapp', etc.
  threadId: text('thread_id').notNull(),                  // external thread/conversation identifier
  contactId: text('contact_id')
    .references(() => contacts.id, { onDelete: 'set null' }),
  sentAt: integer('sent_at').notNull(),                   // epoch ms — when the outbound message was sent
  expectedResponseBy: integer('expected_response_by'),    // epoch ms — deadline for expected reply
  status: text('status').notNull().default('pending'),    // 'pending' | 'resolved' | 'overdue' | 'nudged'
  reminderCronId: text('reminder_cron_id'),               // optional cron job ID for reminder
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ── Tasks ────────────────────────────────────────────────────────────

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  template: text('template').notNull(),
  inputSchema: text('input_schema'),
  contextFlags: text('context_flags'),
  requiredTools: text('required_tools'),
  createdFromConversationId: text('created_from_conversation_id'),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const taskRuns = sqliteTable('task_runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  conversationId: text('conversation_id'),
  status: text('status').notNull().default('pending'),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  error: text('error'),
  principalId: text('principal_id'),
  memoryScopeId: text('memory_scope_id'),
  createdAt: integer('created_at').notNull(),
});

export const taskCandidates = sqliteTable('task_candidates', {
  id: text('id').primaryKey(),
  sourceConversationId: text('source_conversation_id').notNull(),
  compiledTemplate: text('compiled_template').notNull(),
  confidence: real('confidence'),
  requiredTools: text('required_tools'),               // JSON array string
  createdAt: integer('created_at').notNull(),
  promotedTaskId: text('promoted_task_id'),             // set when candidate is promoted to a real task
});

// ── Work Items (Tasks) ───────────────────────────────────────────────

export const workItems = sqliteTable('work_items', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  title: text('title').notNull(),
  notes: text('notes'),
  status: text('status').notNull().default('queued'),  // queued | running | awaiting_review | failed | cancelled | done | archived
  priorityTier: integer('priority_tier').notNull().default(1), // 0=high, 1=medium, 2=low
  sortIndex: integer('sort_index'),  // manual ordering within same priority tier; null = fall back to updated_at
  lastRunId: text('last_run_id'),
  lastRunConversationId: text('last_run_conversation_id'),
  lastRunStatus: text('last_run_status'),  // 'completed' | 'failed' | null
  sourceType: text('source_type'),  // reserved for future bridge (e.g. 'followup', 'triage')
  sourceId: text('source_id'),      // reserved for future bridge
  requiredTools: text('required_tools'),  // JSON array snapshot of tools needed for this run (null=unknown, []=none, ["bash",...]=specific)
  approvedTools: text('approved_tools'),  // JSON array of pre-approved tool names
  approvalStatus: text('approval_status').default('none'),  // 'none' | 'approved' | 'denied'
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const homeBaseAppLinks = sqliteTable('home_base_app_links', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull(),
  source: text('source').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const publishedPages = sqliteTable('published_pages', {
  id: text('id').primaryKey(),
  deploymentId: text('deployment_id').notNull().unique(),
  publicUrl: text('public_url').notNull(),
  pageTitle: text('page_title'),
  htmlHash: text('html_hash').notNull(),
  publishedAt: integer('published_at').notNull(),
  status: text('status').notNull().default('active'),
  appId: text('app_id'),
  projectSlug: text('project_slug'),
});

// ── Watchers (event-driven polling) ──────────────────────────────────

export const watchers = sqliteTable('watchers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  providerId: text('provider_id').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  pollIntervalMs: integer('poll_interval_ms').notNull().default(60000),
  actionPrompt: text('action_prompt').notNull(),
  watermark: text('watermark'),
  conversationId: text('conversation_id'),
  status: text('status').notNull().default('idle'),         // idle | polling | error | disabled
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  lastError: text('last_error'),
  lastPollAt: integer('last_poll_at'),
  nextPollAt: integer('next_poll_at').notNull(),
  configJson: text('config_json'),
  credentialService: text('credential_service').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const watcherEvents = sqliteTable('watcher_events', {
  id: text('id').primaryKey(),
  watcherId: text('watcher_id')
    .notNull()
    .references(() => watchers.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  eventType: text('event_type').notNull(),
  summary: text('summary').notNull(),
  payloadJson: text('payload_json').notNull(),
  disposition: text('disposition').notNull().default('pending'),  // pending | silent | notify | escalate | error
  llmAction: text('llm_action'),
  processedAt: integer('processed_at'),
  createdAt: integer('created_at').notNull(),
});

export const llmRequestLogs = sqliteTable('llm_request_logs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  requestPayload: text('request_payload').notNull(),
  responsePayload: text('response_payload').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const llmUsageEvents = sqliteTable('llm_usage_events', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
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

// ── Call Sessions (outgoing AI phone calls) ──────────────────────────

export const callSessions = sqliteTable('call_sessions', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerCallSid: text('provider_call_sid'),
  fromNumber: text('from_number').notNull(),
  toNumber: text('to_number').notNull(),
  task: text('task'),
  status: text('status').notNull().default('initiated'),
  callerIdentityMode: text('caller_identity_mode'),
  callerIdentitySource: text('caller_identity_source'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const callEvents = sqliteTable('call_events', {
  id: text('id').primaryKey(),
  callSessionId: text('call_session_id')
    .notNull()
    .references(() => callSessions.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
});

export const callPendingQuestions = sqliteTable('call_pending_questions', {
  id: text('id').primaryKey(),
  callSessionId: text('call_session_id')
    .notNull()
    .references(() => callSessions.id, { onDelete: 'cascade' }),
  questionText: text('question_text').notNull(),
  status: text('status').notNull().default('pending'),
  askedAt: integer('asked_at').notNull(),
  answeredAt: integer('answered_at'),
  answerText: text('answer_text'),
});

export const processedCallbacks = sqliteTable('processed_callbacks', {
  id: text('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  callSessionId: text('call_session_id')
    .notNull()
    .references(() => callSessions.id, { onDelete: 'cascade' }),
  claimId: text('claim_id'),
  createdAt: integer('created_at').notNull(),
});

// ── External Conversation Bindings ───────────────────────────────────
// UNIQUE (source_channel, external_chat_id) enforced via idx_ext_conv_bindings_channel_chat_unique in db.ts

export const externalConversationBindings = sqliteTable('external_conversation_bindings', {
  conversationId: text('conversation_id')
    .primaryKey()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  sourceChannel: text('source_channel').notNull(),
  externalChatId: text('external_chat_id').notNull(),
  externalUserId: text('external_user_id'),
  displayName: text('display_name'),
  username: text('username'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastInboundAt: integer('last_inbound_at'),
  lastOutboundAt: integer('last_outbound_at'),
});
