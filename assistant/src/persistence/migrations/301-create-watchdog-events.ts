import { Database } from "bun:sqlite";

import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import { type DrizzleDb, getTelemetrySqlite } from "../db-connection.js";

/**
 * Create the `watchdog_events` table on the dedicated telemetry database
 * (`assistant-telemetry.db`), not the main DB. The migration runner passes the
 * main DrizzleDb, but this table lives on the telemetry connection, so we open
 * that connection and run DDL against it directly. The dedicated connection
 * itself performs no DDL on open, so this migration owns the schema.
 *
 * Idempotent (`IF NOT EXISTS`). Writes are gated on `share_analytics`
 * consent at the store level, so opted-out rows never exist and the
 * reporter's standard 0 watermark default is safe. The index backs the
 * telemetry reporter's compound `(created_at, id)` watermark cursor.
 *
 * The `mainDb` parameter is accepted to satisfy the migration-step signature but
 * is not used — this migration operates exclusively on the telemetry DB.
 */
export function createWatchdogEventsTable(_mainDb: DrizzleDb): void {
  let raw: Database | null = getTelemetrySqlite();
  if (!raw) {
    // The dedicated connection failed to open (logged by openDedicatedDb).
    // Fall back to opening the file directly so the migration still runs —
    // the singleton will pick it up on a later access. This mirrors the
    // fail-soft pattern of the other dedicated-DB migrations.
    raw = new Database(getTelemetryDbPath());
  }
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS watchdog_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      check_name TEXT NOT NULL,
      value REAL,
      detail TEXT
    )
  `);
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_watchdog_events_created_at_id ON watchdog_events (created_at, id)`,
  );
}
