import type { DrizzleDb } from '../db-connection.js';

/**
 * Originally added an index on memory_item_sources(memory_item_id), but that
 * column is the leftmost key in PRIMARY KEY (memory_item_id, message_id) which
 * SQLite already covers with an autoindex. The explicit index was redundant and
 * added unnecessary write overhead, so it has been removed.
 */
export function migrateMemoryItemSourcesIndexes(database: DrizzleDb): void {
  // Drop the redundant index if it was already created on existing databases.
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_memory_item_sources_memory_item_id`);
}
