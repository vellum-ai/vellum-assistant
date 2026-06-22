import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_memory_retrospective_remembered_log_v1";

const TABLE = "memory_retrospective_state";
const COLUMN = "remembered_log";

/**
 * Add a nullable `remembered_log TEXT` column to `memory_retrospective_state`.
 *
 * Stores a JSON array of strings — the cumulative `remember` contents saved
 * by retrospective passes over the conversation (capped; see
 * `memory-retrospective-state.ts`). The retrospective job's
 * `<already_remembered>` dedup block reads from this log so it survives GC of
 * superseded retrospective conversations and spans more than the last pass.
 *
 * `NULL` for rows persisted before this migration ran — the job falls back
 * to scanning the prior retrospective conversation for those.
 *
 * Idempotent — the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateMemoryRetrospectiveRememberedLog(
  database: DrizzleDb,
): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    const raw = getSqliteFrom(database);

    const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
      name: string;
    }>;
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has(COLUMN)) {
      raw.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
    }
  });
}
