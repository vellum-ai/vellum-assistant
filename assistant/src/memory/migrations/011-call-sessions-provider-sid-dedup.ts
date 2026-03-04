import { getLogger } from "../../util/logger.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const log = getLogger("memory-db");

/**
 * One-shot migration: remove duplicate (provider, provider_call_sid) rows from
 * call_sessions so that the unique index can be created safely on upgraded databases
 * that pre-date the constraint.
 *
 * For each set of duplicates, the most recently updated row is kept.
 */
export function migrateCallSessionsProviderSidDedup(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  // Quick check: if the unique index already exists, no dedup is needed.
  const idxExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_call_sessions_provider_sid_unique'`,
    )
    .get();
  if (idxExists) return;

  // Check if the table even exists yet (first boot).
  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'call_sessions'`,
    )
    .get();
  if (!tableExists) return;

  // Count duplicates before doing any work.
  const dupCount = raw
    .query(
      /*sql*/ `
    SELECT COUNT(*) AS c FROM (
      SELECT provider, provider_call_sid
      FROM call_sessions
      WHERE provider_call_sid IS NOT NULL
      GROUP BY provider, provider_call_sid
      HAVING COUNT(*) > 1
    )
  `,
    )
    .get() as { c: number } | null;

  if (!dupCount || dupCount.c === 0) return;

  log.warn(
    { duplicateGroups: dupCount.c },
    "Deduplicating call_sessions with duplicate provider_call_sid before creating unique index",
  );

  try {
    raw.exec("BEGIN");

    // Keep the most recently updated row per (provider, provider_call_sid);
    // delete the rest.
    raw.exec(/*sql*/ `
      DELETE FROM call_sessions
      WHERE provider_call_sid IS NOT NULL
        AND rowid NOT IN (
          SELECT MAX(rowid) FROM call_sessions
          WHERE provider_call_sid IS NOT NULL
          GROUP BY provider, provider_call_sid
        )
    `);

    raw.exec("COMMIT");
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}
