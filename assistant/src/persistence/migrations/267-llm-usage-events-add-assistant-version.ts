import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const COLUMN = "assistant_version";
const TABLE = "llm_usage_events";

/**
 * Add a nullable `assistant_version TEXT` column to `llm_usage_events`.
 *
 * Stamps the version of the assistant binary at the moment the event was
 * RECORDED, not when the batch was uploaded. The previous shape sent the
 * version only on the upload envelope, which silently mis-attributes
 * delayed flushes: an assistant that buffered events for days (offline
 * laptop, network outage, ingest clog — see May 2026 incident) and
 * finally flushed under its current version stamps that current version
 * onto every backlogged event, breaking the version filter on
 * `/admin/inference`.
 *
 * `NULL` for rows persisted before this migration ran. The reporter
 * falls back to the running binary's `APP_VERSION` when the per-event
 * column is null, so legacy rows still produce a concrete version on
 * the wire.
 *
 * Scope: only `llm_usage_events` for now. `lifecycle_events` (#18112)
 * and `onboarding_events` (#30733) share the same record-time-attribution
 * issue and will get the column in a follow-up. Turn events derive from
 * the `messages` table and are also out of scope — see follow-up that
 * adds the column to `messages`.
 *
 * Idempotent — re-running is a no-op once the column exists. Pure DDL
 * with a PRAGMA guard, no registry entry needed (matches the 252 / 261
 * / 264 / 265 pattern).
 */
export function migrateLlmUsageEventsAddAssistantVersion(
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
