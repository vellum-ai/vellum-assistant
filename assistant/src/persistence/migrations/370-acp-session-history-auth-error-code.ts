import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_session_history";
const COLUMN = "auth_error_code";

/**
 * Add a nullable `auth_error_code TEXT` column to `acp_session_history`.
 *
 * Names the credential failure that ended a run, so a client that reopens the
 * conversation can re-raise the inline "Connect Claude Code" card for it. The
 * row is the right home for that: it already carries the parent conversation
 * and the spawning tool call the card anchors to, nothing rewrites it the way
 * a turn's finalize rewrites message content, and it outlives the daemon
 * process, so retirement does not depend on anything held in memory.
 *
 * `NULL` for rows persisted before this migration ran, and for every run that
 * ended for any other reason.
 *
 * Idempotent: the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateAcpSessionHistoryAuthErrorCode(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has(COLUMN)) {
    raw.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  }
}
