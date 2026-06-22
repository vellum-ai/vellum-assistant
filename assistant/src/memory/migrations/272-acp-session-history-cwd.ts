import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_session_history";
const COLUMN = "cwd";

/**
 * Add a nullable `cwd TEXT` column to `acp_session_history`.
 *
 * Records the working directory the ACP agent process was spawned with so
 * that a persisted session can later be resumed (`session/load` /
 * `session/resume` both require the original cwd to reconstruct params).
 *
 * `NULL` for rows persisted before this migration ran — legacy sessions
 * simply are not resumable.
 *
 * Idempotent — the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateAcpSessionHistoryCwd(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has(COLUMN)) {
    raw.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  }
}
