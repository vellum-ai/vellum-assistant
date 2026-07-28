import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * One-shot migration: reconcile old deferral history into the new `deferrals` column.
 *
 * Before the `deferrals` column was added, `deferMemoryJob` incremented `attempts`.
 * After the column is added with DEFAULT 0, those legacy jobs still carry the old
 * attempt count (which was really a deferral count) while `deferrals` is 0. This
 * moves the attempt count into `deferrals` and resets `attempts` to 0.
 *
 * This migration MUST run only once. On subsequent startups, post-migration jobs
 * that genuinely failed via `failMemoryJob` (attempts > 0, deferrals = 0, non-null
 * last_error) must NOT be touched — resetting their attempts would let them bypass
 * the configured maxAttempts budget across restarts.
 *
 * We use a `memory_checkpoints` row to ensure the migration runs exactly once.
 */
export function migrateJobDeferrals(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const checkpoint = raw
    .query(
      `SELECT 1 FROM memory_checkpoints WHERE key = 'migration_job_deferrals'`,
    )
    .get();
  if (checkpoint) return;

  try {
    raw.exec(/*sql*/ `
      BEGIN;
      UPDATE memory_jobs
      SET deferrals = attempts,
          attempts = 0,
          last_error = NULL,
          updated_at = ${Date.now()}
      WHERE status = 'pending'
        AND attempts > 0
        AND deferrals = 0
        AND type IN ('embed_segment', 'embed_item', 'embed_summary');
      INSERT OR IGNORE INTO memory_checkpoints (key, value, updated_at)
      VALUES ('migration_job_deferrals', '1', ${Date.now()});
      COMMIT;
    `);
  } catch (e) {
    try {
      raw.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw e;
  }
}

/**
 * Reverse the deferral reconciliation by moving `deferrals` back into `attempts`
 * for pending embed jobs. Best-effort: jobs that accumulated real deferral counts
 * after the forward migration ran cannot be distinguished from migrated ones.
 */
export function downJobDeferrals(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    UPDATE memory_jobs
    SET attempts = deferrals,
        deferrals = 0,
        updated_at = ${Date.now()}
    WHERE status = 'pending'
      AND deferrals > 0
      AND attempts = 0
      AND type IN ('embed_segment', 'embed_item', 'embed_summary')
  `);
}
