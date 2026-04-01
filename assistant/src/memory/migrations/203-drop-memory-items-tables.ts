import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Drop the legacy memory_items and memory_item_sources tables.
 *
 * All consumers have been migrated to memory_graph_nodes (#22698).
 * These tables are now dead weight.
 */
export function migrateDropMemoryItemsTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Drop indexes first (idempotent — IF EXISTS).
  raw.exec(
    /*sql*/ `DROP INDEX IF EXISTS idx_memory_item_sources_memory_item_id`
  );
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_scope_id`);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_memory_items_fingerprint`);

  // Drop tables (idempotent — IF EXISTS). Child table first.
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_item_sources`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_items`);
}
