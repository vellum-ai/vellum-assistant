import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `proc_candidates`, the procedural-memory candidate registry: one row per
 * recurrence cluster of related notes tracked toward a distilled procedure.
 * `member_note_slugs` is a JSON array of the note slugs that have joined the
 * cluster, `count` is the observed recurrence tally, and `status` walks
 * `observing → ready → distilled` as a cluster accumulates evidence and is
 * eventually distilled into a procedure. `explicit` flags clusters seeded by a
 * direct user request rather than passive observation.
 *
 * Idempotent — re-running is a no-op once the table and index exist.
 */
export function createProcCandidatesTable(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS proc_candidates (
      cluster_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      member_note_slugs TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'observing',
      explicit INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_proc_candidates_status
      ON proc_candidates (status)
  `);
}
