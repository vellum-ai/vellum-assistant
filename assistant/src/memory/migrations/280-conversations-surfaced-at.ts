import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add a nullable `surfaced_at` column to `conversations`.
 *
 * Non-null marks a background/scheduled conversation as explicitly promoted
 * ("surfaced") into the sidebar's Recents grouping. Promotion is always an
 * explicit API call (`POST /v1/conversations/:id/surface`) — nothing sets
 * this automatically, so all existing rows stay NULL and default sidebar
 * behavior is unchanged.
 *
 * Idempotent — re-running is a no-op once the column and index exist.
 */
export function migrateConversationsSurfacedAt(database: DrizzleDb): void {
  if (!tableHasColumn(database, "conversations", "surfaced_at")) {
    database.run(
      `ALTER TABLE conversations ADD COLUMN surfaced_at INTEGER DEFAULT NULL`,
    );
  }
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_conversations_surfaced_at ON conversations (surfaced_at)`,
  );
}
