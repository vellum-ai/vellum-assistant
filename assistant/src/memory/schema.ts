import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalEstimatedCost: real("total_estimated_cost").notNull().default(0),
    contextSummary: text("context_summary"),
    contextCompactedMessageCount: integer("context_compacted_message_count")
      .notNull()
      .default(0),
    contextCompactedAt: integer("context_compacted_at"),
    threadType: text("thread_type").notNull().default("standard"),
    source: text("source").notNull().default("user"),
    memoryScopeId: text("memory_scope_id").notNull().default("default"),
    originChannel: text("origin_channel"),
    originInterface: text("origin_interface"),
    isAutoTitle: integer("is_auto_title").notNull().default(1),
    scheduleJobId: text("schedule_job_id"),
  },
  (table) => [
    index("idx_conversations_updated_at").on(table.updatedAt),
    index("idx_conversations_thread_type").on(table.threadType),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [index("idx_messages_conversation_id").on(table.conversationId)],
);

export const toolInvocations = sqliteTable(
  "tool_invocations",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    toolName: text("tool_name").notNull(),
    input: text("input").notNull(),
    result: text("result").notNull(),
    decision: text("decision").notNull(),
    riskLevel: text("risk_level").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_tool_invocations_conversation_id").on(table.conversationId),
  ],
);

export const memorySegments = sqliteTable(
  "memory_segments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    text: text("text").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    scopeId: text("scope_id").notNull().default("default"),
    contentHash: text("content_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_memory_segments_scope_id").on(table.scopeId)],
);

export const memoryItems = sqliteTable(
  "memory_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    statement: text("statement").notNull(),
    status: text("status").notNull(),
    confidence: real("confidence").notNull(),
    importance: real("importance"),
    accessCount: integer("access_count").notNull().default(0),
    fingerprint: text("fingerprint").notNull(),
    verificationState: text("verification_state")
      .notNull()
      .default("assistant_inferred"),
    scopeId: text("scope_id").notNull().default("default"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    validFrom: integer("valid_from"),
    invalidAt: integer("invalid_at"),
  },
  (table) => [
    index("idx_memory_items_scope_id").on(table.scopeId),
    index("idx_memory_items_fingerprint").on(table.fingerprint),
  ],
);

export const memoryItemSources = sqliteTable(
  "memory_item_sources",
  {
    memoryItemId: text("memory_item_id")
      .notNull()
      .references(() => memoryItems.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    evidence: text("evidence"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_memory_item_sources_memory_item_id").on(table.memoryItemId),
  ],
);

export const memoryItemConflicts = sqliteTable(
  "memory_item_conflicts",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    existingItemId: text("existing_item_id")
      .notNull()
      .references(() => memoryItems.id, { onDelete: "cascade" }),
    candidateItemId: text("candidate_item_id")
      .notNull()
      .references(() => memoryItems.id, { onDelete: "cascade" }),
    relationship: text("relationship").notNull(),
    status: text("status").notNull(),
    clarificationQuestion: text("clarification_question"),
    resolutionNote: text("resolution_note"),
    lastAskedAt: integer("last_asked_at"),
    resolvedAt: integer("resolved_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_memory_item_conflicts_scope_id").on(table.scopeId)],
);

export const memorySummaries = sqliteTable(
  "memory_summaries",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    summary: text("summary").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    version: integer("version").notNull().default(1),
    scopeId: text("scope_id").notNull().default("default"),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_memory_summaries_scope_id").on(table.scopeId),
    uniqueIndex("idx_memory_summaries_scope_scope_key").on(
      table.scope,
      table.scopeKey,
    ),
  ],
);

export const memoryEmbeddings = sqliteTable(
  "memory_embeddings",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    vectorJson: text("vector_json"),
    vectorBlob: blob("vector_blob"),
    contentHash: text("content_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_memory_embeddings_target_provider_model").on(
      table.targetType,
      table.targetId,
      table.provider,
      table.model,
    ),
  ],
);

export const memoryJobs = sqliteTable("memory_jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  deferrals: integer("deferrals").notNull().default(0),
  runAfter: integer("run_after").notNull(),
  lastError: text("last_error"),
  startedAt: integer("started_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const conversationKeys = sqliteTable("conversation_keys", {
  id: text("id").primaryKey(),
  conversationKey: text("conversation_key").notNull(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  kind: text("kind").notNull(),
  dataBase64: text("data_base64").notNull(),
  contentHash: text("content_hash"),
  thumbnailBase64: text("thumbnail_base64"),
  createdAt: integer("created_at").notNull(),
});

export const messageAttachments = sqliteTable("message_attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  attachmentId: text("attachment_id")
    .notNull()
    .references(() => attachments.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

export const channelInboundEvents = sqliteTable("channel_inbound_events", {
  id: text("id").primaryKey(),
  sourceChannel: text("source_channel").notNull(),
  externalChatId: text("external_chat_id").notNull(),
  externalMessageId: text("external_message_id").notNull(),
  sourceMessageId: text("source_message_id"),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => messages.id, {
    onDelete: "cascade",
  }),
  deliveryStatus: text("delivery_status").notNull().default("pending"),
  processingStatus: text("processing_status").notNull().default("pending"),
  processingAttempts: integer("processing_attempts").notNull().default(0),
  lastProcessingError: text("last_processing_error"),
  retryAfter: integer("retry_after"),
  rawPayload: text("raw_payload"),
  deliveredSegmentCount: integer("delivered_segment_count")
    .notNull()
    .default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memoryCheckpoints = sqliteTable("memory_checkpoints", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Reminders ────────────────────────────────────────────────────────

export const reminders = sqliteTable("reminders", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  message: text("message").notNull(),
  fireAt: integer("fire_at").notNull(), // epoch ms, absolute timestamp
  mode: text("mode").notNull(), // 'notify' | 'execute'
  status: text("status").notNull(), // 'pending' | 'firing' | 'fired' | 'cancelled'
  firedAt: integer("fired_at"),
  conversationId: text("conversation_id"),
  routingIntent: text("routing_intent").notNull().default("all_channels"), // 'single_channel' | 'multi_channel' | 'all_channels'
  routingHintsJson: text("routing_hints_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Recurrence Schedules ─────────────────────────────────────────────

export const cronJobs = sqliteTable("cron_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  cronExpression: text("cron_expression").notNull(), // e.g. '0 9 * * 1-5'
  scheduleSyntax: text("schedule_syntax").notNull().default("cron"), // 'cron' | 'rrule'
  timezone: text("timezone"), // e.g. 'America/Los_Angeles'
  message: text("message").notNull(),
  nextRunAt: integer("next_run_at").notNull(),
  lastRunAt: integer("last_run_at"),
  lastStatus: text("last_status"), // 'ok' | 'error'
  retryCount: integer("retry_count").notNull().default(0),
  createdBy: text("created_by").notNull(), // 'agent' | 'user'
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  service: text("service").notNull(),
  username: text("username"),
  email: text("email"),
  displayName: text("display_name"),
  status: text("status").notNull().default("active"),
  credentialRef: text("credential_ref"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const cronRuns = sqliteTable("cron_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => cronJobs.id, { onDelete: "cascade" }),
  status: text("status").notNull(), // 'ok' | 'error'
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  durationMs: integer("duration_ms"),
  output: text("output"),
  error: text("error"),
  conversationId: text("conversation_id"),
  createdAt: integer("created_at").notNull(),
});

// Recurrence-centric aliases — prefer these in new code.
// Physical table names remain `cron_jobs` / `cron_runs` for migration compatibility.
export const scheduleJobs = cronJobs;
export const scheduleRuns = cronRuns;

// ── LLM Usage Events (cost tracking ledger) ─────────────────────────

// ── Entity Graph ─────────────────────────────────────────────────────

export const memoryEntities = sqliteTable("memory_entities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  aliases: text("aliases"),
  description: text("description"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  mentionCount: integer("mention_count").notNull().default(1),
});

export const memoryEntityRelations = sqliteTable("memory_entity_relations", {
  id: text("id").primaryKey(),
  sourceEntityId: text("source_entity_id").notNull(),
  targetEntityId: text("target_entity_id").notNull(),
  relation: text("relation").notNull(),
  evidence: text("evidence"),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
});

export const memoryItemEntities = sqliteTable("memory_item_entities", {
  memoryItemId: text("memory_item_id").notNull(),
  entityId: text("entity_id").notNull(),
});

export const sharedAppLinks = sqliteTable("shared_app_links", {
  id: text("id").primaryKey(),
  shareToken: text("share_token").notNull().unique(),
  bundleData: blob("bundle_data", { mode: "buffer" }).notNull(),
  bundleSizeBytes: integer("bundle_size_bytes").notNull(),
  manifestJson: text("manifest_json").notNull(),
  downloadCount: integer("download_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
});

// ── Contacts ─────────────────────────────────────────────────────────

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  notes: text("notes"),
  lastInteraction: integer("last_interaction"), // epoch ms
  interactionCount: integer("interaction_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  role: text("role").notNull().default("contact"), // 'guardian' | 'contact'
  principalId: text("principal_id"), // internal auth principal (nullable)
  assistantId: text("assistant_id"), // which assistant this guardian is for (nullable, daemon default is DAEMON_INTERNAL_ASSISTANT_ID)
  contactType: text("contact_type").notNull().default("human"), // 'human' | 'assistant'
});

export const contactChannels = sqliteTable(
  "contact_channels",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // 'email', 'slack', 'whatsapp', 'phone', etc.
    address: text("address").notNull(), // the actual identifier on that channel
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    externalUserId: text("external_user_id"), // channel-native user ID (e.g., Telegram numeric ID, E.164 phone)
    externalChatId: text("external_chat_id"), // delivery/notification routing address (e.g., Telegram chat ID)
    status: text("status").notNull().default("unverified"), // 'active' | 'pending' | 'revoked' | 'blocked' | 'unverified'
    policy: text("policy").notNull().default("allow"), // 'allow' | 'deny' | 'escalate'
    verifiedAt: integer("verified_at"), // epoch ms
    verifiedVia: text("verified_via"), // 'challenge' | 'invite' | 'bootstrap' | etc.
    inviteId: text("invite_id"), // reference to invite that onboarded
    revokedReason: text("revoked_reason"),
    blockedReason: text("blocked_reason"),
    lastSeenAt: integer("last_seen_at"), // epoch ms
    updatedAt: integer("updated_at"), // epoch ms
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_contact_channels_type_ext_user").on(
      table.type,
      table.externalUserId,
    ),
    index("idx_contact_channels_type_ext_chat").on(
      table.type,
      table.externalChatId,
    ),
  ],
);

export const assistantContactMetadata = sqliteTable(
  "assistant_contact_metadata",
  {
    contactId: text("contact_id")
      .primaryKey()
      .references(() => contacts.id, { onDelete: "cascade" }),
    species: text("species").notNull(), // 'vellum' | 'openclaw'
    metadata: text("metadata"), // JSON blob for species-specific fields
  },
);

// ── Follow-ups ──────────────────────────────────────────────────────

export const followups = sqliteTable("followups", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(), // 'email', 'slack', 'whatsapp', etc.
  threadId: text("thread_id").notNull(), // external thread/conversation identifier
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

// ── Tasks ────────────────────────────────────────────────────────────

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

// ── Work Items (Tasks) ───────────────────────────────────────────────

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

export const homeBaseAppLinks = sqliteTable("home_base_app_links", {
  id: text("id").primaryKey(),
  appId: text("app_id").notNull(),
  source: text("source").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const publishedPages = sqliteTable("published_pages", {
  id: text("id").primaryKey(),
  deploymentId: text("deployment_id").notNull().unique(),
  publicUrl: text("public_url").notNull(),
  pageTitle: text("page_title"),
  htmlHash: text("html_hash").notNull(),
  publishedAt: integer("published_at").notNull(),
  status: text("status").notNull().default("active"),
  appId: text("app_id"),
  projectSlug: text("project_slug"),
});

// ── Watchers (event-driven polling) ──────────────────────────────────

export const watchers = sqliteTable("watchers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  providerId: text("provider_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  pollIntervalMs: integer("poll_interval_ms").notNull().default(60000),
  actionPrompt: text("action_prompt").notNull(),
  watermark: text("watermark"),
  conversationId: text("conversation_id"),
  status: text("status").notNull().default("idle"), // idle | polling | error | disabled
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  lastError: text("last_error"),
  lastPollAt: integer("last_poll_at"),
  nextPollAt: integer("next_poll_at").notNull(),
  configJson: text("config_json"),
  credentialService: text("credential_service").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const watcherEvents = sqliteTable("watcher_events", {
  id: text("id").primaryKey(),
  watcherId: text("watcher_id")
    .notNull()
    .references(() => watchers.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json").notNull(),
  disposition: text("disposition").notNull().default("pending"), // pending | silent | notify | escalate | error
  llmAction: text("llm_action"),
  processedAt: integer("processed_at"),
  createdAt: integer("created_at").notNull(),
});

export const llmRequestLogs = sqliteTable("llm_request_logs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  requestPayload: text("request_payload").notNull(),
  responsePayload: text("response_payload").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const llmUsageEvents = sqliteTable(
  "llm_usage_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    requestId: text("request_id"),
    actor: text("actor").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationInputTokens: integer("cache_creation_input_tokens"),
    cacheReadInputTokens: integer("cache_read_input_tokens"),
    estimatedCostUsd: real("estimated_cost_usd"),
    pricingStatus: text("pricing_status").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => [
    index("idx_llm_usage_events_conversation_id").on(table.conversationId),
  ],
);

// ── Call Sessions (outgoing AI phone calls) ──────────────────────────

export const callSessions = sqliteTable(
  "call_sessions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerCallSid: text("provider_call_sid"),
    fromNumber: text("from_number").notNull(),
    toNumber: text("to_number").notNull(),
    task: text("task"),
    status: text("status").notNull().default("initiated"),
    callMode: text("call_mode"),
    guardianVerificationSessionId: text("guardian_verification_session_id"),
    callerIdentityMode: text("caller_identity_mode"),
    callerIdentitySource: text("caller_identity_source"),
    assistantId: text("assistant_id"),
    initiatedFromConversationId: text("initiated_from_conversation_id"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_call_sessions_status").on(table.status)],
);

export const callEvents = sqliteTable("call_events", {
  id: text("id").primaryKey(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const callPendingQuestions = sqliteTable("call_pending_questions", {
  id: text("id").primaryKey(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  questionText: text("question_text").notNull(),
  status: text("status").notNull().default("pending"),
  askedAt: integer("asked_at").notNull(),
  answeredAt: integer("answered_at"),
  answerText: text("answer_text"),
});

export const processedCallbacks = sqliteTable("processed_callbacks", {
  id: text("id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  callSessionId: text("call_session_id")
    .notNull()
    .references(() => callSessions.id, { onDelete: "cascade" }),
  claimId: text("claim_id"),
  createdAt: integer("created_at").notNull(),
});

// ── External Conversation Bindings ───────────────────────────────────
// UNIQUE (source_channel, external_chat_id) enforced via idx_ext_conv_bindings_channel_chat_unique in db.ts

export const externalConversationBindings = sqliteTable(
  "external_conversation_bindings",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sourceChannel: text("source_channel").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    externalUserId: text("external_user_id"),
    displayName: text("display_name"),
    username: text("username"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastInboundAt: integer("last_inbound_at"),
    lastOutboundAt: integer("last_outbound_at"),
  },
);

// ── Channel Guardian Bindings ────────────────────────────────────────
// Dropped in migration 131-drop-legacy-member-guardian-tables.
// Data lives in the contacts/contact_channels tables.

// ── Channel Guardian Verification Challenges ─────────────────────────

export const channelGuardianVerificationChallenges = sqliteTable(
  "channel_guardian_verification_challenges",
  {
    id: text("id").primaryKey(),
    assistantId: text("assistant_id").notNull(),
    channel: text("channel").notNull(),
    challengeHash: text("challenge_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    createdBySessionId: text("created_by_session_id"),
    consumedByExternalUserId: text("consumed_by_external_user_id"),
    consumedByChatId: text("consumed_by_chat_id"),
    // Outbound session: expected-identity binding
    expectedExternalUserId: text("expected_external_user_id"),
    expectedChatId: text("expected_chat_id"),
    expectedPhoneE164: text("expected_phone_e164"),
    identityBindingStatus: text("identity_binding_status").default("bound"),
    // Outbound session: delivery tracking
    destinationAddress: text("destination_address"),
    lastSentAt: integer("last_sent_at"),
    sendCount: integer("send_count").default(0),
    nextResendAt: integer("next_resend_at"),
    // Session configuration
    codeDigits: integer("code_digits").default(6),
    maxAttempts: integer("max_attempts").default(3),
    // Distinguishes guardian verification from trusted contact verification
    verificationPurpose: text("verification_purpose").default("guardian"),
    // Telegram bootstrap deep-link token hash
    bootstrapTokenHash: text("bootstrap_token_hash"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

// ── Channel Guardian Approval Requests ───────────────────────────────

export const channelGuardianApprovalRequests = sqliteTable(
  "channel_guardian_approval_requests",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    requestId: text("request_id"),
    conversationId: text("conversation_id").notNull(),
    assistantId: text("assistant_id")
      .notNull()
      .default(DAEMON_INTERNAL_ASSISTANT_ID),
    channel: text("channel").notNull(),
    requesterExternalUserId: text("requester_external_user_id").notNull(),
    requesterChatId: text("requester_chat_id").notNull(),
    guardianExternalUserId: text("guardian_external_user_id").notNull(),
    guardianChatId: text("guardian_chat_id").notNull(),
    toolName: text("tool_name").notNull(),
    riskLevel: text("risk_level"),
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    decidedByExternalUserId: text("decided_by_external_user_id"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

// ── Channel Guardian Verification Rate Limits ────────────────────────

export const channelGuardianRateLimits = sqliteTable(
  "channel_guardian_rate_limits",
  {
    id: text("id").primaryKey(),
    assistantId: text("assistant_id").notNull(),
    channel: text("channel").notNull(),
    actorExternalUserId: text("actor_external_user_id").notNull(),
    actorChatId: text("actor_chat_id").notNull(),
    // Legacy columns kept with defaults for backward compatibility with upgraded databases
    // that still have the old NOT NULL columns without DEFAULT. Not read by app logic.
    invalidAttempts: integer("invalid_attempts").notNull().default(0),
    windowStartedAt: integer("window_started_at").notNull().default(0),
    attemptTimestampsJson: text("attempt_timestamps_json")
      .notNull()
      .default("[]"),
    lockedUntil: integer("locked_until"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

// ── Media Assets ─────────────────────────────────────────────────────

export const mediaAssets = sqliteTable("media_assets", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  filePath: text("file_path").notNull(),
  mimeType: text("mime_type").notNull(),
  durationSeconds: real("duration_seconds"),
  fileHash: text("file_hash").notNull(),
  status: text("status").notNull().default("registered"), // registered | processing | indexed | failed
  mediaType: text("media_type").notNull(), // video | audio | image
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const processingStages = sqliteTable("processing_stages", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  status: text("status").notNull().default("pending"), // pending | running | completed | failed
  progress: integer("progress").notNull().default(0), // 0-100
  lastError: text("last_error"),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
});

export const mediaKeyframes = sqliteTable("media_keyframes", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  timestamp: real("timestamp").notNull(),
  filePath: text("file_path").notNull(),
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
});

export const mediaVisionOutputs = sqliteTable("media_vision_outputs", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  keyframeId: text("keyframe_id")
    .notNull()
    .references(() => mediaKeyframes.id, { onDelete: "cascade" }),
  analysisType: text("analysis_type").notNull(),
  output: text("output").notNull(), // JSON
  confidence: real("confidence"),
  createdAt: integer("created_at").notNull(),
});

export const mediaTimelines = sqliteTable("media_timelines", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  segmentType: text("segment_type").notNull(),
  attributes: text("attributes"), // JSON
  confidence: real("confidence"),
  createdAt: integer("created_at").notNull(),
});

export const mediaEvents = sqliteTable("media_events", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  confidence: real("confidence").notNull(),
  reasons: text("reasons").notNull(), // JSON array
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at").notNull(),
});

export const mediaTrackingProfiles = sqliteTable("media_tracking_profiles", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  capabilities: text("capabilities").notNull(), // JSON: { [capName]: { enabled, tier } }
  createdAt: integer("created_at").notNull(),
});

export const mediaEventFeedback = sqliteTable("media_event_feedback", {
  id: text("id").primaryKey(),
  assetId: text("asset_id")
    .notNull()
    .references(() => mediaAssets.id, { onDelete: "cascade" }),
  eventId: text("event_id")
    .notNull()
    .references(() => mediaEvents.id, { onDelete: "cascade" }),
  feedbackType: text("feedback_type").notNull(), // correct | incorrect | boundary_edit | missed
  originalStartTime: real("original_start_time"),
  originalEndTime: real("original_end_time"),
  correctedStartTime: real("corrected_start_time"),
  correctedEndTime: real("corrected_end_time"),
  notes: text("notes"),
  createdAt: integer("created_at").notNull(),
});

// ── Guardian Action Requests (cross-channel voice guardian) ──────────

export const guardianActionRequests = sqliteTable(
  "guardian_action_requests",
  {
    id: text("id").primaryKey(),
    assistantId: text("assistant_id")
      .notNull()
      .default(DAEMON_INTERNAL_ASSISTANT_ID),
    kind: text("kind").notNull(), // 'ask_guardian'
    sourceChannel: text("source_channel").notNull(), // 'voice'
    sourceConversationId: text("source_conversation_id").notNull(),
    callSessionId: text("call_session_id")
      .notNull()
      .references(() => callSessions.id, { onDelete: "cascade" }),
    pendingQuestionId: text("pending_question_id")
      .notNull()
      .references(() => callPendingQuestions.id, { onDelete: "cascade" }),
    questionText: text("question_text").notNull(),
    requestCode: text("request_code").notNull(), // short human-readable code for routing replies
    status: text("status").notNull().default("pending"), // pending | answered | expired | cancelled
    answerText: text("answer_text"),
    answeredByChannel: text("answered_by_channel"),
    answeredByExternalUserId: text("answered_by_external_user_id"),
    answeredAt: integer("answered_at"),
    expiresAt: integer("expires_at").notNull(),
    expiredReason: text("expired_reason"), // call_timeout | sweep_timeout | cancelled
    followupState: text("followup_state").notNull().default("none"), // none | awaiting_guardian_choice | dispatching | completed | declined | failed
    lateAnswerText: text("late_answer_text"),
    lateAnsweredAt: integer("late_answered_at"),
    followupAction: text("followup_action"), // call_back | message_back | decline
    followupCompletedAt: integer("followup_completed_at"),
    toolName: text("tool_name"), // tool identity for tool-approval requests
    inputDigest: text("input_digest"), // canonical SHA-256 digest of tool input
    supersededByRequestId: text("superseded_by_request_id"), // links to the request that replaced this one
    supersededAt: integer("superseded_at"), // epoch ms when supersession occurred
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_guardian_action_requests_session_status_created").on(
      table.callSessionId,
      table.status,
      table.createdAt,
    ),
  ],
);

// ── Guardian Action Deliveries (per-channel delivery tracking) ───────

export const guardianActionDeliveries = sqliteTable(
  "guardian_action_deliveries",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => guardianActionRequests.id, { onDelete: "cascade" }),
    destinationChannel: text("destination_channel").notNull(), // 'telegram' | 'sms' | 'vellum'
    destinationConversationId: text("destination_conversation_id"),
    destinationChatId: text("destination_chat_id"),
    destinationExternalUserId: text("destination_external_user_id"),
    status: text("status").notNull().default("pending"), // pending | sent | failed | answered | expired | cancelled
    sentAt: integer("sent_at"),
    respondedAt: integer("responded_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_guardian_action_deliveries_dest_conversation").on(
      table.destinationConversationId,
    ),
  ],
);

// ── Canonical Guardian Requests (unified cross-source guardian domain) ─

export const canonicalGuardianRequests = sqliteTable(
  "canonical_guardian_requests",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    sourceType: text("source_type").notNull(),
    sourceChannel: text("source_channel"),
    conversationId: text("conversation_id"),
    requesterExternalUserId: text("requester_external_user_id"),
    requesterChatId: text("requester_chat_id"),
    guardianExternalUserId: text("guardian_external_user_id"),
    guardianPrincipalId: text("guardian_principal_id"),
    callSessionId: text("call_session_id"),
    pendingQuestionId: text("pending_question_id"),
    questionText: text("question_text"),
    requestCode: text("request_code"),
    toolName: text("tool_name"),
    inputDigest: text("input_digest"),
    status: text("status").notNull().default("pending"),
    answerText: text("answer_text"),
    decidedByExternalUserId: text("decided_by_external_user_id"),
    decidedByPrincipalId: text("decided_by_principal_id"),
    followupState: text("followup_state"),
    expiresAt: text("expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_canonical_guardian_requests_status").on(table.status),
    index("idx_canonical_guardian_requests_guardian").on(
      table.guardianExternalUserId,
      table.status,
    ),
    index("idx_canonical_guardian_requests_conversation").on(
      table.conversationId,
      table.status,
    ),
    index("idx_canonical_guardian_requests_source").on(
      table.sourceType,
      table.status,
    ),
    index("idx_canonical_guardian_requests_kind").on(table.kind, table.status),
    index("idx_canonical_guardian_requests_request_code").on(table.requestCode),
  ],
);

// ── Canonical Guardian Deliveries (per-channel delivery tracking) ─────

export const canonicalGuardianDeliveries = sqliteTable(
  "canonical_guardian_deliveries",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id")
      .notNull()
      .references(() => canonicalGuardianRequests.id, { onDelete: "cascade" }),
    destinationChannel: text("destination_channel").notNull(),
    destinationConversationId: text("destination_conversation_id"),
    destinationChatId: text("destination_chat_id"),
    destinationMessageId: text("destination_message_id"),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_canonical_guardian_deliveries_request_id").on(table.requestId),
    index("idx_canonical_guardian_deliveries_status").on(table.status),
  ],
);

// ── Assistant Inbox ──────────────────────────────────────────────────

export const assistantIngressInvites = sqliteTable(
  "assistant_ingress_invites",
  {
    id: text("id").primaryKey(),
    assistantId: text("assistant_id")
      .notNull()
      .default(DAEMON_INTERNAL_ASSISTANT_ID),
    sourceChannel: text("source_channel").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBySessionId: text("created_by_session_id"),
    note: text("note"),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    status: text("status").notNull().default("active"),
    redeemedByExternalUserId: text("redeemed_by_external_user_id"),
    redeemedByExternalChatId: text("redeemed_by_external_chat_id"),
    redeemedAt: integer("redeemed_at"),
    // Voice invite fields (nullable — non-voice invites leave these NULL)
    expectedExternalUserId: text("expected_external_user_id"),
    voiceCodeHash: text("voice_code_hash"),
    voiceCodeDigits: integer("voice_code_digits"),
    // Display metadata for personalized voice prompts (nullable — non-voice invites leave these NULL)
    friendName: text("friend_name"),
    guardianName: text("guardian_name"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

// ── Assistant Ingress Members ─────────────────────────────────────────
// Dropped in migration 131-drop-legacy-member-guardian-tables.
// Data lives in the contacts/contact_channels tables.

export const assistantInboxThreadState = sqliteTable(
  "assistant_inbox_thread_state",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id")
      .notNull()
      .default(DAEMON_INTERNAL_ASSISTANT_ID),
    sourceChannel: text("source_channel").notNull(),
    externalChatId: text("external_chat_id").notNull(),
    externalUserId: text("external_user_id"),
    displayName: text("display_name"),
    username: text("username"),
    lastInboundAt: integer("last_inbound_at"),
    lastOutboundAt: integer("last_outbound_at"),
    lastMessageAt: integer("last_message_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    pendingEscalationCount: integer("pending_escalation_count")
      .notNull()
      .default(0),
    hasPendingEscalation: integer("has_pending_escalation")
      .notNull()
      .default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

// ── Notification System ──────────────────────────────────────────────

export const notificationEvents = sqliteTable("notification_events", {
  id: text("id").primaryKey(),
  assistantId: text("assistant_id").notNull(),
  sourceEventName: text("source_event_name").notNull(),
  sourceChannel: text("source_channel").notNull(),
  sourceSessionId: text("source_session_id").notNull(),
  attentionHintsJson: text("attention_hints_json").notNull().default("{}"),
  payloadJson: text("payload_json").notNull().default("{}"),
  dedupeKey: text("dedupe_key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const notificationDecisions = sqliteTable("notification_decisions", {
  id: text("id").primaryKey(),
  notificationEventId: text("notification_event_id")
    .notNull()
    .references(() => notificationEvents.id, { onDelete: "cascade" }),
  shouldNotify: integer("should_notify").notNull(),
  selectedChannels: text("selected_channels").notNull().default("[]"),
  reasoningSummary: text("reasoning_summary").notNull(),
  confidence: real("confidence").notNull(),
  fallbackUsed: integer("fallback_used").notNull().default(0),
  promptVersion: text("prompt_version"),
  validationResults: text("validation_results"),
  createdAt: integer("created_at").notNull(),
});

export const notificationPreferences = sqliteTable("notification_preferences", {
  id: text("id").primaryKey(),
  assistantId: text("assistant_id").notNull(),
  preferenceText: text("preference_text").notNull(),
  appliesWhenJson: text("applies_when_json").notNull().default("{}"),
  priority: integer("priority").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Sequences (multi-step outreach) ──────────────────────────────────

export const sequences = sqliteTable("sequences", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  channel: text("channel").notNull(),
  steps: text("steps").notNull(), // JSON array of SequenceStep
  exitOnReply: integer("exit_on_reply", { mode: "boolean" })
    .notNull()
    .default(true),
  status: text("status").notNull().default("active"), // active | paused | archived
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sequenceEnrollments = sqliteTable(
  "sequence_enrollments",
  {
    id: text("id").primaryKey(),
    sequenceId: text("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    contactEmail: text("contact_email").notNull(),
    contactName: text("contact_name"),
    currentStep: integer("current_step").notNull().default(0),
    status: text("status").notNull().default("active"), // active | paused | completed | replied | cancelled | failed
    threadId: text("thread_id"),
    nextStepAt: integer("next_step_at"), // epoch ms
    context: text("context"), // JSON
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_seq_enrollments_status_next_step").on(
      table.status,
      table.nextStepAt,
    ),
    index("idx_seq_enrollments_sequence_id").on(table.sequenceId),
    index("idx_seq_enrollments_contact_email").on(table.contactEmail),
  ],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    notificationDecisionId: text("notification_decision_id")
      .notNull()
      .references(() => notificationDecisions.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id").notNull(),
    channel: text("channel").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(1),
    renderedTitle: text("rendered_title"),
    renderedBody: text("rendered_body"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sentAt: integer("sent_at"),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    conversationStrategy: text("conversation_strategy"),
    threadAction: text("thread_action"),
    threadTargetConversationId: text("thread_target_conversation_id"),
    threadDecisionFallbackUsed: integer("thread_decision_fallback_used"),
    clientDeliveryStatus: text("client_delivery_status"),
    clientDeliveryError: text("client_delivery_error"),
    clientDeliveryAt: integer("client_delivery_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_notification_deliveries_decision_channel").on(
      table.notificationDecisionId,
      table.channel,
    ),
  ],
);

// ── Conversation Attention ───────────────────────────────────────────

export const conversationAttentionEvents = sqliteTable(
  "conversation_attention_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id").notNull(),
    sourceChannel: text("source_channel").notNull(),
    signalType: text("signal_type").notNull(),
    confidence: text("confidence").notNull(),
    source: text("source").notNull(),
    evidenceText: text("evidence_text"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    observedAt: integer("observed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_conv_attn_events_conv_observed").on(
      table.conversationId,
      table.observedAt,
    ),
    index("idx_conv_attn_events_assistant_observed").on(
      table.assistantId,
      table.observedAt,
    ),
    index("idx_conv_attn_events_channel_observed").on(
      table.sourceChannel,
      table.observedAt,
    ),
  ],
);

export const conversationAssistantAttentionState = sqliteTable(
  "conversation_assistant_attention_state",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    assistantId: text("assistant_id").notNull(),
    latestAssistantMessageId: text("latest_assistant_message_id"),
    latestAssistantMessageAt: integer("latest_assistant_message_at"),
    lastSeenAssistantMessageId: text("last_seen_assistant_message_id"),
    lastSeenAssistantMessageAt: integer("last_seen_assistant_message_at"),
    lastSeenEventAt: integer("last_seen_event_at"),
    lastSeenConfidence: text("last_seen_confidence"),
    lastSeenSignalType: text("last_seen_signal_type"),
    lastSeenSourceChannel: text("last_seen_source_channel"),
    lastSeenSource: text("last_seen_source"),
    lastSeenEvidenceText: text("last_seen_evidence_text"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_conv_attn_state_assistant_latest_msg").on(
      table.assistantId,
      table.latestAssistantMessageAt,
    ),
    index("idx_conv_attn_state_assistant_last_seen").on(
      table.assistantId,
      table.lastSeenAssistantMessageAt,
    ),
  ],
);

// ── Actor Token Records ──────────────────────────────────────────────

export const actorTokenRecords = sqliteTable("actor_token_records", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  assistantId: text("assistant_id").notNull(),
  guardianPrincipalId: text("guardian_principal_id").notNull(),
  hashedDeviceId: text("hashed_device_id").notNull(),
  platform: text("platform").notNull(),
  status: text("status").notNull().default("active"),
  issuedAt: integer("issued_at").notNull(),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Actor Refresh Token Records ──────────────────────────────────────

export const actorRefreshTokenRecords = sqliteTable(
  "actor_refresh_token_records",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    familyId: text("family_id").notNull(),
    assistantId: text("assistant_id").notNull(),
    guardianPrincipalId: text("guardian_principal_id").notNull(),
    hashedDeviceId: text("hashed_device_id").notNull(),
    platform: text("platform").notNull(),
    status: text("status").notNull().default("active"),
    issuedAt: integer("issued_at").notNull(),
    absoluteExpiresAt: integer("absolute_expires_at").notNull(),
    inactivityExpiresAt: integer("inactivity_expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

// ── Scoped Approval Grants ──────────────────────────────────────────

export const scopedApprovalGrants = sqliteTable(
  "scoped_approval_grants",
  {
    id: text("id").primaryKey(),
    assistantId: text("assistant_id").notNull(),
    scopeMode: text("scope_mode").notNull(), // 'request_id' | 'tool_signature'
    requestId: text("request_id"),
    toolName: text("tool_name"),
    inputDigest: text("input_digest"),
    requestChannel: text("request_channel").notNull(),
    decisionChannel: text("decision_channel").notNull(),
    executionChannel: text("execution_channel"), // null = any channel
    conversationId: text("conversation_id"),
    callSessionId: text("call_session_id"),
    requesterExternalUserId: text("requester_external_user_id"),
    guardianExternalUserId: text("guardian_external_user_id"),
    status: text("status").notNull(), // 'active' | 'consumed' | 'expired' | 'revoked'
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    consumedByRequestId: text("consumed_by_request_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_scoped_grants_request_id").on(table.requestId),
    index("idx_scoped_grants_tool_sig").on(table.toolName, table.inputDigest),
    index("idx_scoped_grants_status_expires").on(table.status, table.expiresAt),
  ],
);
