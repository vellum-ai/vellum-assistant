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
 * `tool_executed` telemetry projection: serialized payload sizes (only the
 * sizes leave the device, never the payloads) and the conversation's model
 * attribution at invocation time. Nullable so pre-migration and
 * permission-denied rows stay NULL (see the legacy-row filter in
 * tool-executed-events-store.ts).
 *
 * Idempotent pure DDL with a PRAGMA guard, no registry entry needed
 * (matches the 273 / 275 pattern).
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
