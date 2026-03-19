import {
  index,
  integer,
  real,
  sqliteTable,
  text,
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
    conversationType: text("conversation_type").notNull().default("standard"),
    source: text("source").notNull().default("user"),
    memoryScopeId: text("memory_scope_id").notNull().default("default"),
    originChannel: text("origin_channel"),
    originInterface: text("origin_interface"),
    isAutoTitle: integer("is_auto_title").notNull().default(1),
    scheduleJobId: text("schedule_job_id"),
  },
  (table) => [
    index("idx_conversations_updated_at").on(table.updatedAt),
    index("idx_conversations_conversation_type").on(table.conversationType),
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
