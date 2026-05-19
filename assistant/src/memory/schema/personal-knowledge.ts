import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const pkbEntities = sqliteTable(
  "pkb_entities",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    entityType: text("entity_type").notNull(),
    canonicalName: text("canonical_name").notNull(),
    aliasesJson: text("aliases_json").notNull().default("[]"),
    attributesJson: text("attributes_json").notNull().default("{}"),
    confidence: real("confidence").notNull().default(0.5),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Added in migration 242 (Memory Maturation MVP).
    evidenceCount: integer("evidence_count").notNull().default(1),
    lastReinforcedAt: integer("last_reinforced_at"),
    provenanceJson: text("provenance_json").notNull().default("[]"),
  },
  (table) => [
    uniqueIndex("idx_pkb_entities_scope_type_name").on(
      table.scopeId,
      table.entityType,
      table.canonicalName,
    ),
    index("idx_pkb_entities_scope_updated").on(table.scopeId, table.updatedAt),
  ],
);

export const pkbEpisodes = sqliteTable(
  "pkb_episodes",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    entityId: text("entity_id").references(() => pkbEntities.id, {
      onDelete: "set null",
    }),
    summary: text("summary").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    happenedAt: integer("happened_at").notNull(),
    salience: real("salience").notNull().default(0.5),
    sourceConversationId: text("source_conversation_id"),
    createdAt: integer("created_at").notNull(),
    // Added in migration 242 (Memory Maturation MVP).
    idempotencyKey: text("idempotency_key"),
  },
  (table) => [
    index("idx_pkb_episodes_scope_happened").on(
      table.scopeId,
      table.happenedAt,
    ),
    index("idx_pkb_episodes_scope_salience").on(table.scopeId, table.salience),
    index("idx_pkb_episodes_entity").on(table.entityId),
  ],
);

export const pkbPreferences = sqliteTable(
  "pkb_preferences",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    key: text("key").notNull(),
    value: text("value").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    learnedFrom: text("learned_from").notNull().default("inferred"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // Added in migration 242 (Memory Maturation MVP).
    evidenceCount: integer("evidence_count").notNull().default(1),
    positiveCount: integer("positive_count").notNull().default(1),
    negativeCount: integer("negative_count").notNull().default(0),
    lastReinforcedAt: integer("last_reinforced_at"),
    lastContradictedAt: integer("last_contradicted_at"),
  },
  (table) => [
    uniqueIndex("idx_pkb_preferences_scope_key").on(table.scopeId, table.key),
    index("idx_pkb_preferences_scope_updated").on(
      table.scopeId,
      table.updatedAt,
    ),
  ],
);
