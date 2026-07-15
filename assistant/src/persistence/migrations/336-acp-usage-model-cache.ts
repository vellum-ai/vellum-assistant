import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const TABLE = "acp_session_history";
const COLUMNS: Array<{ name: string; type: string }> = [
  { name: "model", type: "TEXT" },
  { name: "cache_read_tokens", type: "INTEGER" },
  { name: "cache_write_tokens", type: "INTEGER" },
];

/**
 * Add nullable model + cache-token columns to `acp_session_history`:
 * `model`, `cache_read_tokens`, and `cache_write_tokens`. Nullable so rows
 * persisted before this migration stay NULL.
 *
 * Idempotent pure DDL with a PRAGMA guard, no registry entry needed (matches
 * the 307 / 308 usage-columns pattern).
 */
export function migrateAcpSessionHistoryModelCacheColumns(
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
