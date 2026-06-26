import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_session_history";
const COLUMNS: Array<{ name: string; type: string }> = [
  { name: "input_tokens", type: "INTEGER" },
  { name: "output_tokens", type: "INTEGER" },
];

/**
 * Add nullable cumulative token columns to `acp_session_history`:
 * `input_tokens` and `output_tokens`. Nullable so rows persisted before this
 * migration stay NULL.
 *
 * Idempotent pure DDL with a PRAGMA guard, no registry entry needed (matches
 * the 307 usage-columns pattern).
 */
export function migrateAcpSessionHistoryTokenColumns(
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
