import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Drop entity-related tables that are no longer used.
 *
 * Entity search has been replaced by hybrid search on entity-rich text
 * in item statements, so these tables are now dead weight.
 */
export function migrateDropEntityTables(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_item_entities`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_entity_relations`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS memory_entities`);
}
