import {
  blob,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Memory Graph — Drizzle ORM schema
// ---------------------------------------------------------------------------

export const memoryGraphNodes = sqliteTable(
  "memory_graph_nodes",
  {
    id: text("id").primaryKey(),

    /** First-person prose — how the assistant naturally remembers this. */
    content: text("content").notNull(),
    /** Memory type: episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared. */
    type: text("type").notNull(),

    // -- Temporal --
    /** Epoch ms. Hour/dayOfWeek/month derived at query time via Date. */
    created: integer("created").notNull(),
    /** Epoch ms. Decay-rate modifier only — NOT a retrieval signal. */
    lastAccessed: integer("last_accessed").notNull(),
    /** Epoch ms of last consolidation pass. */
    lastConsolidated: integer("last_consolidated").notNull(),
    /** Epoch ms of the event this memory describes (null for non-event memories). */
    eventDate: integer("event_date"),

    // -- Energy --
    /** JSON-serialized EmotionalCharge object. Read/written atomically. */
    emotionalCharge: text("emotional_charge").notNull(),
    /** vivid | clear | faded | gist | gone */
    fidelity: text("fidelity").notNull().default("vivid"),
    /** 0–1. How sure the assistant is this is accurate. */
    confidence: real("confidence").notNull(),
    /** 0–1. How important. Subject to Ebbinghaus decay. */
    significance: real("significance").notNull(),

    // -- Reinforcement --
    /** Resistance to decay. Grows ×1.5 per reinforcement. */
    stability: real("stability").notNull().default(14),
    /** How many times confirmed/reinforced. */
    reinforcementCount: integer("reinforcement_count").notNull().default(0),
    /** Epoch ms. */
    lastReinforced: integer("last_reinforced").notNull(),

    // -- Provenance --
    /** JSON array of conversation IDs. */
    sourceConversations: text("source_conversations").notNull().default("[]"),
    /** direct | inferred | observed | told-by-other */
    sourceType: text("source_type").notNull().default("inferred"),

    // -- Narrative --
    narrativeRole: text("narrative_role"),
    partOfStory: text("part_of_story"),

    /** Memory scope for multi-scope isolation. */
    scopeId: text("scope_id").notNull().default("default"),

    /** JSON array of ImageRef objects — images attached to this memory. */
    imageRefs: text("image_refs"),
  },
  (table) => [
    index("idx_graph_nodes_scope_id").on(table.scopeId),
    index("idx_graph_nodes_type").on(table.type),
    index("idx_graph_nodes_fidelity").on(table.fidelity),
    index("idx_graph_nodes_created").on(table.created),
    index("idx_graph_nodes_significance").on(table.significance),
    index("idx_graph_nodes_event_date").on(table.eventDate),
  ],
);

export const memoryGraphEdges = sqliteTable(
  "memory_graph_edges",
  {
    id: text("id").primaryKey(),
    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => memoryGraphNodes.id, { onDelete: "cascade" }),
    targetNodeId: text("target_node_id")
      .notNull()
      .references(() => memoryGraphNodes.id, { onDelete: "cascade" }),
    /** caused-by | reminds-of | contradicts | depends-on | part-of | supersedes | resolved-by */
    relationship: text("relationship").notNull(),
    /** Connection strength 0–1. */
    weight: real("weight").notNull().default(1.0),
    /** Epoch ms. */
    created: integer("created").notNull(),
  },
  (table) => [
    index("idx_graph_edges_source").on(table.sourceNodeId),
    index("idx_graph_edges_target").on(table.targetNodeId),
  ],
);

export const memoryGraphTriggers = sqliteTable(
  "memory_graph_triggers",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => memoryGraphNodes.id, { onDelete: "cascade" }),
    /** temporal | semantic | event */
    type: text("type").notNull(),

    // -- Temporal --
    schedule: text("schedule"),

    // -- Semantic --
    condition: text("condition"),
    /** Pre-computed embedding stored as binary blob. */
    conditionEmbedding: blob("condition_embedding"),
    /** Cosine similarity threshold (0–1). */
    threshold: real("threshold"),

    // -- Event --
    /** Epoch ms of the event date. */
    eventDate: integer("event_date"),
    rampDays: integer("ramp_days"),
    followUpDays: integer("follow_up_days"),

    // -- State --
    recurring: integer("recurring", { mode: "boolean" })
      .notNull()
      .default(false),
    consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
    cooldownMs: integer("cooldown_ms"),
    lastFired: integer("last_fired"),
  },
  (table) => [
    index("idx_graph_triggers_node_id").on(table.nodeId),
    index("idx_graph_triggers_type").on(table.type),
  ],
);

export const memoryGraphNodeEdits = sqliteTable("memory_graph_node_edits", {
  id: text("id").primaryKey(),
  nodeId: text("node_id")
    .notNull()
    .references(() => memoryGraphNodes.id, { onDelete: "cascade" }),
  previousContent: text("previous_content").notNull(),
  newContent: text("new_content").notNull(),
  source: text("source").notNull(),
  conversationId: text("conversation_id"),
  created: integer("created").notNull(),
});

// ---------------------------------------------------------------------------
// Memory v2 — activation_state
// ---------------------------------------------------------------------------

/**
 * Per-conversation snapshot of the v2 retrieval state. One row per
 * conversation; created lazily on first injection.
 *
 * - `stateJson`: sparse `{slug: activation}` map (only slugs > epsilon).
 * - `everInjectedJson`: append-only `[{slug, turn}]` list used to keep
 *   per-turn injections strictly delta-only. Pruned when compaction evicts
 *   the turns whose attached slugs lived on.
 *
 * No FK to conversations.id — fork() may copy state for a child
 * conversation that hasn't been persisted yet, and stale rows are cheap.
 */
export const activationState = sqliteTable("activation_state", {
  conversationId: text("conversation_id").primaryKey(),
  messageId: text("message_id").notNull(),
  stateJson: text("state_json").notNull(),
  everInjectedJson: text("ever_injected_json").notNull().default("[]"),
  currentTurn: integer("current_turn").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
