import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Drops `proc_candidates` and its status index.
 *
 * Idempotent — re-running is a no-op once the table and index are gone.
 */
export function dropProcCandidatesTable(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP INDEX IF EXISTS idx_proc_candidates_status;`);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS proc_candidates;`);
}
