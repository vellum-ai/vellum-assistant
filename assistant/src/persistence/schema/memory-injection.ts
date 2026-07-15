import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Time-series of memory-v2 card injections, used by the router to decay a
// concept's recent injection pressure. Lives in the dedicated memory database
// (`assistant-memory.db`), not main — access it via the memory connection
// (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryV2InjectionEvents = sqliteTable(
  "memory_v2_injection_events",
  {
    id: integer("id").primaryKey(),
    slug: text("slug").notNull(),
    injectedAt: integer("injected_at").notNull(),
  },
  (table) => [
    index("idx_memory_v2_injection_events_slug_time").on(
      table.slug,
      table.injectedAt,
    ),
    index("idx_memory_v2_injection_events_time").on(table.injectedAt),
  ],
);

// Per-conversation record of every memory-v3 card ever injected, with a
// pruned_at tombstone so re-injection can be suppressed after pruning.
export const memoryV3EverInjected = sqliteTable(
  "memory_v3_ever_injected",
  {
    conversationId: text("conversation_id").notNull(),
    slug: text("slug").notNull(),
    injectedAt: integer("injected_at").notNull(),
    bytes: integer("bytes").notNull().default(0),
    prunedAt: integer("pruned_at"),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.slug] }),
    index("idx_memory_v3_ever_injected_conv").on(table.conversationId),
  ],
);

// Per-turn log of which memory-v3 cards were selected, with lane attribution.
// Lives in the dedicated memory database (`assistant-memory.db`), not main —
// access it via the memory connection (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryV3Selections = sqliteTable(
  "memory_v3_selections",
  {
    conversationId: text("conversation_id").notNull(),
    turn: integer("turn").notNull(),
    slug: text("slug").notNull(),
    source: text("source").notNull(),
    pinned: integer("pinned").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    messageId: text("message_id"),
    sectionOrdinal: integer("section_ordinal"),
    sectionTitle: text("section_title"),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.turn, table.slug] }),
    index("idx_memory_v3_selections_conv").on(table.conversationId, table.turn),
  ],
);
