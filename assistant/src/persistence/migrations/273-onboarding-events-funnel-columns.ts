import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const TABLE = "onboarding_events";
const COLUMNS: Array<{ name: string; type: string }> = [
  { name: "session_id", type: "TEXT" },
  { name: "step_name", type: "TEXT" },
  { name: "step_index", type: "INTEGER" },
  { name: "completed_at", type: "TEXT" },
  { name: "funnel_version", type: "TEXT" },
];

/**
 * Add nullable funnel-tracking columns to `onboarding_events`.
 *
 * The original table (#30733) recorded one row per onboarding screen but had
 * no way to stitch those rows into an ordered, per-attempt funnel: there was
 * no session correlator, no step ordering, and no completion timestamp. These
 * columns let the activation-funnel reporting attribute each event to a single
 * onboarding attempt (`session_id`), order steps within it (`step_name` /
 * `step_index`), record when a step finished (`completed_at`), and version the
 * funnel shape so changes to the step set don't silently corrupt historical
 * conversion math (`funnel_version`).
 *
 * All columns are nullable — `NULL` for rows persisted before this migration
 * ran.
 *
 * Idempotent — re-running is a no-op once the columns exist. Pure DDL with a
 * PRAGMA guard, no registry entry needed (matches the 252 / 261 / 264 / 265 /
 * 267 pattern).
 */
export function migrateOnboardingEventsFunnelColumns(
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
