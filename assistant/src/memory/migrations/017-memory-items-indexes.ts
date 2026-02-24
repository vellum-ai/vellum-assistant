import type { DrizzleDb } from '../db-connection.js';

/**
 * Idempotent migration to add indexes on memory_items for scope_id and
 * fingerprint — critical for duplicate detection and scope-filtered queries.
 */
export function migrateMemoryItemsIndexes(database: DrizzleDb): void {
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_scope_id ON memory_items(scope_id)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_fingerprint ON memory_items(fingerprint)`);
}
