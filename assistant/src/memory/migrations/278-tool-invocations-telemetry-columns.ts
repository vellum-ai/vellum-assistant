import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const TABLE = "tool_invocations";
const COLUMNS: Array<{ name: string; type: string }> = [
  { name: "arg_bytes", type: "INTEGER" },
  { name: "result_bytes", type: "INTEGER" },
  { name: "provider", type: "TEXT" },
  { name: "model", type: "TEXT" },
  { name: "inference_profile", type: "TEXT" },
  { name: "inference_profile_source", type: "TEXT" },
];

/**
 * Add nullable telemetry columns to `tool_invocations` for the
 * `tool_executed` telemetry projection.
 *
 * `arg_bytes` / `result_bytes` record the serialized payload sizes computed
 * by the audit listener BEFORE the stored `result` column is truncated and
 * redacted — only the sizes leave the device, never the payloads. The
 * `provider` / `model` / `inference_profile` / `inference_profile_source`
 * columns snapshot the conversation's model attribution at invocation time
 * (same mapping the `llm_usage` events use).
 *
 * All columns are nullable — `NULL` for rows persisted before this migration
 * ran and for permission-denied rows (the tool never executed; they are
 * filtered out of the telemetry projection).
 *
 * Idempotent — re-running is a no-op once the columns exist. Pure DDL with a
 * PRAGMA guard, no registry entry needed (matches the 273 / 275 pattern).
 */
export function migrateToolInvocationsTelemetryColumns(
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
