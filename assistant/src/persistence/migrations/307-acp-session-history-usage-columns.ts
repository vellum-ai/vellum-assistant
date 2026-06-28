import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_session_history";
const COLUMNS: Array<{ name: string; type: string }> = [
  { name: "task", type: "TEXT" },
  { name: "parent_tool_use_id", type: "TEXT" },
  { name: "used_tokens", type: "INTEGER" },
  { name: "context_size", type: "INTEGER" },
  { name: "cost_amount", type: "REAL" },
  { name: "cost_currency", type: "TEXT" },
];

/**
 * Add nullable usage columns to `acp_session_history`: the prompt task, the
 * parent tool-use id that spawned the session, token/context counts, and the
 * reported cost. Nullable so rows persisted before this migration stay NULL.
 *
 * Idempotent pure DDL with a PRAGMA guard, no registry entry needed (matches
 * the 272 / 278 pattern).
 */
export function migrateAcpSessionHistoryUsageColumns(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  for (const { name, type } of COLUMNS) {
    if (!columnNames.has(name)) {
      raw.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${type}`);
    }
  }
}
