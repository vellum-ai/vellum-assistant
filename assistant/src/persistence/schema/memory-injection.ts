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

// Per-conversation record of every memory-v3 section ever injected, keyed by
// (page slug, section key: `""` for the page lead or capability content), with
// a pruned_at tombstone so re-injection can be suppressed after pruning. Lives
// in the dedicated memory database (`assistant-memory.db`), not main, access
// it via the memory connection (`getMemoryDb()` / `getMemorySqlite()`). The
// legacy card-grain `memory_v3_ever_injected` table stays on disk (migrations
// are append-only) but nothing reads or writes it.
export const memoryV3InjectedSections = sqliteTable(
  "memory_v3_injected_sections",
  {
    conversationId: text("conversation_id").notNull(),
    slug: text("slug").notNull(),
    sectionKey: text("section_key").notNull(),
    injectedAt: integer("injected_at").notNull(),
    bytes: integer("bytes").notNull().default(0),
    prunedAt: integer("pruned_at"),
    /** For a lead entry, the exact length of the frozen entry in history:
     *  the card length the section store's schema ensure copies in from `memory_v3_ever_injected` for pre-escaping cards, or the
     *  span the truncated-fork seeder measured. Never refreshed by a
     *  re-injection, so it stays the block parser's boundary evidence for
     *  the persisted copy. `null` for entries recorded by this build's
     *  injector. */
    frozenCardBytes: integer("frozen_card_bytes"),
  },
  (table) => [
    primaryKey({
      columns: [table.conversationId, table.slug, table.sectionKey],
    }),
    index("idx_memory_v3_injected_sections_conv").on(table.conversationId),
  ],
);

// Per-turn log of which memory-v3 pages were selected, with lane attribution.
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
    /** The matched section's `sectionKey` (`v3/types.ts`), the identity the
     *  inspector resolves the section by. Plugin-owned: added by the memory
     *  plugin's schema ensure (`v3/plugin-schema.ts`), not by the migration
     *  chain. `null` for rows written before the column existed and for
     *  selections with no matched section. */
    sectionKey: text("section_key"),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.turn, table.slug] }),
    index("idx_memory_v3_selections_conv").on(table.conversationId, table.turn),
  ],
);

// Per-turn audit record of the memory-v3 selector's candidate pool: every
// stable-prefix card and finder line the selector saw, in pool order, with its
// lane, matched section, and verdict (`candidates_json`), and whether the
// selector judged the pool at all (`selector_ran`; a hard-skipped turn is an
// empty pool with 0). One row per (conversation, turn); `message_id` is
// stamped by the turn-end backfill so the inspector can join it to the turn.
// Lives in the dedicated memory database (`assistant-memory.db`), not main.
// Access it via the memory connection (`getMemoryDb()` / `getMemorySqlite()`).
export const memoryV3Pools = sqliteTable(
  "memory_v3_pools",
  {
    conversationId: text("conversation_id").notNull(),
    turn: integer("turn").notNull(),
    messageId: text("message_id"),
    createdAt: integer("created_at").notNull(),
    poolSize: integer("pool_size").notNull(),
    selectedCount: integer("selected_count").notNull(),
    selectorRan: integer("selector_ran").notNull().default(1),
    candidatesJson: text("candidates_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.turn] }),
    index("idx_memory_v3_pools_message").on(table.messageId),
    index("idx_memory_v3_pools_conv").on(table.conversationId, table.turn),
  ],
);
