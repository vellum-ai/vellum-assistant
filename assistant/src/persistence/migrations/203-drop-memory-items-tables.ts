import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Drop the legacy memory_items and memory_item_sources tables.
 *
 * All consumers have been migrated to memory_graph_nodes (#22698).
 * These tables are now dead weight.
 *
 * Safety: only drops tables when they are empty or the tool-created-items
 * migration has already copied relevant rows into memory_graph_nodes.
 * Workspaces that haven't run migrateToolCreatedItems() yet keep the tables
 * so data isn't silently lost.
 */
export function migrateDropMemoryItemsTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Guard: verify tables are safe to drop (empty or already migrated).
  try {
    const row = raw
      .prepare(
        /*sql*/ `SELECT COUNT(*) as cnt FROM memory_items WHERE status = 'active'`,
      )
      .get() as { cnt: number } | undefined;

    if (row && row.cnt > 0) {
      // Tables have active rows — only drop if the migration checkpoint exists.
      const checkpoint = raw
        .prepare(/*sql*/ `SELECT value FROM memory_checkpoints WHERE key = ?`)
        .get("graph_bootstrap:migrated_tool_items") as
        | { value: string }
        | undefined;

      if (!checkpoint?.value) {
        // Data exists but hasn't been migrated — skip the drop to prevent data loss.
        return;
      }
    }
  } catch {
    // Table doesn't exist (fresh install) — proceed with drop (IF EXISTS is a no-op).
  }

  // Drop indexes first (idempotent — IF EXISTS).
  raw.exec(
    /*sql*/ `DROP INDEX IF EXISTS idx_memory_item_sources_memory_item_id`,
  );
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_scope_id`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_fingerprint`);

  // Drop tables (idempotent — IF EXISTS). Child table first.
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_item_sources`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_items`);
}
