import type { DrizzleDb } from "../db-connection.js";

/**
 * Drops `memory_v3_coactivation` and `memory_v3_auto_edges`. No current code
 * reads or writes either table — `memory_v3_edge_learning` is a retired job
 * type whose rows the jobs worker drops without a handler — so the tables
 * only grow the main DB with rows nothing consults.
 *
 * Idempotent: DROP TABLE IF EXISTS (indexes are dropped with the tables).
 */
export function migrateDropMemoryV3LearnedEdgeTables(
  database: DrizzleDb,
): void {
  database.run(/*sql*/ `DROP TABLE IF EXISTS memory_v3_coactivation`);
  database.run(/*sql*/ `DROP TABLE IF EXISTS memory_v3_auto_edges`);
}
