import type { DrizzleDb } from '../db-connection.js';

/**
 * Idempotent migration to add an index on memory_item_sources.memory_item_id.
 * This column is used in inArray() queries in the memory retriever and as a
 * foreign key with ON DELETE CASCADE — both benefit from an index.
 */
export function migrateMemoryItemSourcesIndexes(database: DrizzleDb): void {
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_memory_item_sources_memory_item_id ON memory_item_sources(memory_item_id)`);
}
