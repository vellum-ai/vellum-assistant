import { Database } from "bun:sqlite";

import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import {
  type DrizzleDb,
  getSqliteFrom,
  getTelemetrySqlite,
} from "../db-connection.js";

/**
 * The telemetry flush watermark keys that historically lived in the main
 * DB's `memory_checkpoints` ledger. Frozen: this is the complete set at the
 * time `flush_checkpoints` was introduced — event types added later start
 * their cursors directly in the new table, so this list must never grow.
 *
 * Enumerated exactly (rather than pattern-matched) because other
 * `telemetry:`-prefixed checkpoints exist in `memory_checkpoints` that are
 * NOT flush watermarks (e.g. `telemetry:installation_id`,
 * `telemetry:watchers:inventory_last_recorded`) and must stay where they
 * are.
 */
const LEGACY_WATERMARK_KEYS = [
  "usage",
  "turns",
  "lifecycle",
  "onboarding",
  "auth_fallback",
  "tool_executed",
  "skill_loaded",
  "watchdog",
  "config_setting",
].flatMap((type) => [
  `telemetry:${type}:last_reported_at`,
  `telemetry:${type}:last_reported_id`,
]);

/**
 * Create the `flush_checkpoints` table on the dedicated telemetry database
 * (`assistant-telemetry.db`) and move the telemetry reporter's watermark
 * cursors into it from the main DB's `memory_checkpoints`, which is reserved
 * for DB-migration checkpoints.
 *
 * Idempotent and crash-safe without a cross-DB transaction: the copy uses
 * `INSERT OR IGNORE` (a re-run never overwrites a value the reporter has
 * since advanced) and the main-DB delete runs last, so a crash between copy
 * and delete re-runs both harmlessly.
 */
export function createFlushCheckpointsTable(mainDb: DrizzleDb): void {
  let telemetry: Database | null = getTelemetrySqlite();
  if (!telemetry) {
    // The dedicated connection failed to open (logged by openDedicatedDb).
    // Fall back to opening the file directly so the migration still runs —
    // the singleton will pick it up on a later access. This mirrors the
    // fail-soft pattern of the other dedicated-DB migrations.
    telemetry = new Database(getTelemetryDbPath());
  }
  telemetry.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS flush_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const main = getSqliteFrom(mainDb);
  const placeholders = LEGACY_WATERMARK_KEYS.map(() => "?").join(", ");
  const rows = main
    .query(
      /*sql*/ `SELECT key, value FROM memory_checkpoints WHERE key IN (${placeholders})`,
    )
    .all(...LEGACY_WATERMARK_KEYS) as Array<{ key: string; value: string }>;

  const now = Date.now();
  const insert = telemetry.prepare(
    /*sql*/ `INSERT OR IGNORE INTO flush_checkpoints (key, value, updated_at) VALUES (?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.key, row.value, now);
  }

  main
    .query(
      /*sql*/ `DELETE FROM memory_checkpoints WHERE key IN (${placeholders})`,
    )
    .run(...LEGACY_WATERMARK_KEYS);
}
