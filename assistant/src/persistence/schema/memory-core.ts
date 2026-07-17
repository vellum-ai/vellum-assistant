import {
  blob,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { conversations, messages } from "./conversations.js";

export const memorySegments = sqliteTable("memory_segments", {
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
  contentHash: text("content_hash"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memorySummaries = sqliteTable(
  "memory_summaries",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    summary: text("summary").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    version: integer("version").notNull().default(1),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
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

// Background job queue for the memory plugin. Lives in the dedicated memory
// database (`assistant-memory.db`), not main — access it via the memory
// connection (`getMemoryDb()` / `getMemorySqlite()`).
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

export const memoryRetrospectiveState = sqliteTable(
  "memory_retrospective_state",
  {
    conversationId: text("conversation_id").primaryKey(),
    lastProcessedMessageId: text("last_processed_message_id").notNull(),
    lastRunAt: integer("last_run_at").notNull(),
    // JSON array of strings — cumulative `remember` contents from prior
    // retrospective passes (capped; see memory-retrospective-state.ts).
    // NULL for rows that predate migration 281 or have no saves yet.
    rememberedLog: text("remembered_log"),
  },
);
