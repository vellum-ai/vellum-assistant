import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { conversations, messages } from "./conversations.js";

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
    supersedes: text("supersedes"),
    supersededBy: text("superseded_by"),
    overrideConfidence: text("override_confidence").default("inferred"),
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

export const memoryCheckpoints = sqliteTable("memory_checkpoints", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const threadStarters = sqliteTable(
  "thread_starters",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    prompt: text("prompt").notNull(),
    generationBatch: integer("generation_batch").notNull(),
    scopeId: text("scope_id").notNull().default("default"),
    sourceMemoryKinds: text("source_memory_kinds"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_thread_starters_batch").on(
      table.generationBatch,
      table.createdAt,
    ),
  ],
);
