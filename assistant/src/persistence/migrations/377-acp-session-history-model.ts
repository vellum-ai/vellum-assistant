import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_session_history";
const COLUMN = "model";

/**
 * Add a nullable `model TEXT` column to `acp_session_history`.
 *
 * Records which model the adapter confirmed the run was on, so a finished run
 * can say what produced it. It is a record of the past, not the source a later
 * spawn inherits from: history is written once at terminal transition, while
 * inheritance has to answer before a run starts. That question belongs to
 * `acp_conversation_model_preference`.
 *
 * `NULL` for rows written before this migration ran, and for every run on an
 * adapter that advertises no model selector.
 *
 * Idempotent: the PRAGMA guard makes re-running a no-op once the column
 * exists.
 */
export function migrateAcpSessionHistoryModel(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has(COLUMN)) {
    raw.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  }
}
