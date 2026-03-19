import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { conversations, messages } from "./conversations.js";

/**
 * Raw observation records captured from conversation turns. Each observation
 * is a single factual statement extracted from user or assistant messages,
 * annotated with modality and source metadata for downstream recall.
 */
export const memoryObservations = sqliteTable(
  "memory_observations",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    /** The role that produced the observation (e.g. "user", "assistant"). */
    role: text("role").notNull(),
    /** Free-text statement capturing the observed fact. */
    content: text("content").notNull(),
    /**
     * Modality of the source material: "text", "voice", "image", etc.
     * Enables downstream filters for recall relevance.
     */
    modality: text("modality").notNull().default("text"),
    /**
     * Source channel or interface that produced the observation
     * (e.g. "vellum", "telegram", "phone").
     */
    source: text("source"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_memory_observations_scope_id").on(table.scopeId),
    index("idx_memory_observations_conversation_id").on(table.conversationId),
    index("idx_memory_observations_created_at").on(table.createdAt),
  ],
);

/**
 * Deduplicated content chunks derived from observations. Chunks are the unit
 * of embedding and recall — each chunk carries a contentHash for idempotent
 * dual-write safety so the same content is never stored twice.
 */
export const memoryChunks = sqliteTable(
  "memory_chunks",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    observationId: text("observation_id")
      .notNull()
      .references(() => memoryObservations.id, { onDelete: "cascade" }),
    /** The chunk text used for embedding and recall. */
    content: text("content").notNull(),
    /** Token count estimate for context-window budgeting. */
    tokenEstimate: integer("token_estimate").notNull(),
    /**
     * SHA-256 hash of the normalized content, used to skip duplicate inserts
     * during dual-write windows.
     */
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_memory_chunks_scope_id").on(table.scopeId),
    index("idx_memory_chunks_observation_id").on(table.observationId),
    uniqueIndex("idx_memory_chunks_content_hash").on(
      table.scopeId,
      table.contentHash,
    ),
    index("idx_memory_chunks_created_at").on(table.createdAt),
  ],
);

/**
 * Episode records that group related observations into coherent narrative
 * units. An episode represents a meaningful interaction or topic span,
 * with source-link metadata for provenance tracking.
 */
export const memoryEpisodes = sqliteTable(
  "memory_episodes",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Human-readable title summarizing the episode. */
    title: text("title").notNull(),
    /** Longer narrative summary of the episode content. */
    summary: text("summary").notNull(),
    /** Token count estimate for the summary. */
    tokenEstimate: integer("token_estimate").notNull(),
    /**
     * Source channel or interface that produced the episode
     * (mirrors observation.source for episode-level filtering).
     */
    source: text("source"),
    /** Epoch-ms timestamp of the earliest observation in the episode. */
    startAt: integer("start_at").notNull(),
    /** Epoch-ms timestamp of the latest observation in the episode. */
    endAt: integer("end_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_memory_episodes_scope_id").on(table.scopeId),
    index("idx_memory_episodes_conversation_id").on(table.conversationId),
    index("idx_memory_episodes_created_at").on(table.createdAt),
  ],
);
