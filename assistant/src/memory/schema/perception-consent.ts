import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Per-conversation consent grants for sensitive perception event kinds
 * (`screen_snapshot`, `audio_excerpt`).
 *
 * Issued via the existing `confirmation_request` → `POST /v1/confirm` flow
 * with `selectedScope: "conversation"`. Subsequent publish-route calls for
 * the same (scope_id, conversation_id, event_kind) triple short-circuit.
 */
export const perceptionConsentGrants = sqliteTable(
  "perception_consent_grants",
  {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().default("default"),
    conversationId: text("conversation_id").notNull(),
    eventKind: text("event_kind").notNull(),
    grantedAt: integer("granted_at").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_perception_consent_grants_triple").on(
      table.scopeId,
      table.conversationId,
      table.eventKind,
    ),
    index("idx_perception_consent_grants_expires").on(table.expiresAt),
  ],
);

export type PerceptionConsentGrantRow =
  typeof perceptionConsentGrants.$inferSelect;
