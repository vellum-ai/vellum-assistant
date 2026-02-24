import type { DrizzleDb } from '../db-connection.js';

/**
 * Idempotent migration to add an index on memory_items.scope_id for
 * scope-filtered queries. The standalone fingerprint index is intentionally
 * omitted — it's superseded by the compound unique index
 * idx_memory_items_fingerprint_scope(fingerprint, scope_id), which already
 * covers single-column lookups on fingerprint as its leading column.
 */
export function migrateMemoryItemsIndexes(database: DrizzleDb): void {
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_items_scope_id ON memory_items(scope_id)`);
}
