import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
    historyStrippedAt: integer("history_stripped_at"),
    slackContextCompactionWatermarkTs: text(
      "slack_context_compaction_watermark_ts",
    ),
    slackContextCompactionWatermarkAt: integer(
      "slack_context_compaction_watermark_at",
    ),
    conversationType: text("conversation_type").notNull().default("standard"),
    source: text("source").notNull().default("user"),
    originChannel: text("origin_channel"),
    originInterface: text("origin_interface"),
    forkParentConversationId: text("fork_parent_conversation_id"),
    forkParentMessageId: text("fork_parent_message_id"),
    isAutoTitle: integer("is_auto_title").notNull().default(1),
    scheduleJobId: text("schedule_job_id"),
    lastMessageAt: integer("last_message_at"),
    archivedAt: integer("archived_at"),
    /**
     * Epoch-ms timestamp set when a background/scheduled conversation is
     * explicitly promoted into the sidebar's Recents grouping. NULL (the
     * default) means not surfaced. Set/cleared only via the surface API —
     * never automatically.
     */
    surfacedAt: integer("surfaced_at"),
    inferenceProfile: text("inference_profile"),
    // JSON-encoded string[] of plugin ids scoping this chat; null = default (all globally-enabled).
    enabledPlugins: text("enabled_plugins"),
    inferenceProfileSessionId: text("inference_profile_session_id"),
    inferenceProfileExpiresAt: integer("inference_profile_expires_at"),
    lastNotifiedInferenceProfile: text("last_notified_inference_profile"),
    /**
     * Epoch-ms timestamp set when the agent loop starts a turn for this
     * conversation, cleared (NULL) when the turn ends. NULL means not
     * processing. This is the cross-process source of truth for processing
     * state — the in-memory `Conversation._processing` flag is the hot-path
     * read for resident conversations, but CLI-side and other out-of-process
     * callers read this column directly.
     */
    processingStartedAt: integer("processing_started_at"),
    /**
     * Count of consecutive startup auto-resume attempts for this
     * conversation's interrupted turn. Incremented by the startup reconciler
     * when it wakes a conversation whose `processing_started_at` survived the
     * previous process; reset to 0 whenever a turn ends cleanly. Caps
     * resume-loops for turns that repeatedly take the process down.
     */
    processingResumeAttempts: integer("processing_resume_attempts")
      .notNull()
      .default(0),
    /**
     * Highest stream `seq` whose content is durably persisted to this
     * conversation's message rows. Seeded with the global high-water seq when
     * the row is inserted and advanced on each persistence flush
     * (`recordConversationPersistedSeq`). Returned by `/messages` as the
     * snapshot↔stream alignment baseline so a client applies only stream
     * events with a higher `seq`. NULL means the conversation was created
     * before any stream activity (global seq 0) or predates this column — the
     * client cold-starts in that case.
     */
    seq: integer("seq"),
  },
  (table) => [
    index("idx_conversations_updated_at").on(table.updatedAt),
    index("idx_conversations_last_message_at").on(table.lastMessageAt),
    index("idx_conversations_conversation_type").on(table.conversationType),
    index("idx_conversations_archived_at").on(table.archivedAt),
    index("idx_conversations_surfaced_at").on(table.surfacedAt),
    index("idx_conversations_fork_parent_conversation_id").on(
      table.forkParentConversationId,
    ),
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
    clientMessageId: text("client_message_id"),
  },
  (table) => [
    uniqueIndex("idx_messages_conv_client_msg_id")
      .on(table.conversationId, table.clientMessageId)
      .where(sql`client_message_id IS NOT NULL`),
  ],
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
    matchedTrustRuleId: text("matched_trust_rule_id"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Serialized input size in bytes, computed before any redaction. Null pre-migration-278. */
    argBytes: integer("arg_bytes"),
    /** Full serialized result size in bytes, computed before truncation/redaction. Null pre-migration-278 and for denied rows. */
    resultBytes: integer("result_bytes"),
    provider: text("provider"),
    model: text("model"),
    inferenceProfile: text("inference_profile"),
    inferenceProfileSource: text("inference_profile_source"),
  },
  (table) => [
    index("idx_tool_invocations_conversation_id").on(table.conversationId),
  ],
);

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
  filePath: text("file_path"),
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

export const conversationGraphMemoryState = sqliteTable(
  "conversation_graph_memory_state",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    stateJson: text("state_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
);

/**
 * Append-only ledger of every compaction event for a conversation. The
 * `conversations` row keeps only the latest compaction (`context_summary` /
 * `context_compacted_message_count` / `context_compacted_at`) as the hot-path
 * cache the load path reads; this table preserves the full history so a fork
 * can inherit the most recent compaction whose event time (`compacted_at`)
 * is at-or-before the boundary message it forks from.
 */
export const conversationCompactionEvents = sqliteTable(
  "conversation_compaction_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    compactedAt: integer("compacted_at").notNull(),
    summary: text("summary").notNull(),
    compactedMessageCount: integer("compacted_message_count").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_compaction_events_conv_at").on(
      table.conversationId,
      table.compactedAt,
    ),
  ],
);

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
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  lastProcessingError: text("last_processing_error"),
  retryAfter: integer("retry_after"),
  rawPayload: text("raw_payload"),
  deliveredSegmentCount: integer("delivered_segment_count")
    .notNull()
    .default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
