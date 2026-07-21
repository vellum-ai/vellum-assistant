import { Database } from "bun:sqlite";

import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import { type DrizzleDb, getTelemetrySqlite } from "../db-connection.js";

/**
 * Create `telemetry_events` — the generic telemetry outbox — on the dedicated
 * telemetry database (`assistant-telemetry.db`), not the main DB. Each row's
 * `payload` holds the wire `TelemetryEvent` JSON built at record time; the
 * usage telemetry reporter deletes rows after a successful flush.
 *
 * Idempotent (`IF NOT EXISTS`). The `(name, created_at, id)` index backs the
 * per-source ordered batch reads; the `conversation_id` index keeps
 * conversation redaction an indexed delete.
 *
 * The `mainDb` parameter is accepted to satisfy the migration-step signature but
 * is not used — this migration operates exclusively on the telemetry DB.
 */
export function migrateCreateTelemetryEventsTable(_mainDb: DrizzleDb): void {
  let raw: Database | null = getTelemetrySqlite();
  if (!raw) {
    // The dedicated connection failed to open (logged by openDedicatedDb).
    // Fall back to opening the file directly so the migration still runs —
    // the singleton will pick it up on a later access. This mirrors the
    // fail-soft pattern of the other dedicated-DB migrations.
    raw = new Database(getTelemetryDbPath());
  }
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      conversation_id TEXT,
      payload TEXT NOT NULL
    )
  `);
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_telemetry_events_name_created_at_id ON telemetry_events (name, created_at, id)`,
  );
  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_telemetry_events_conversation_id ON telemetry_events (conversation_id)`,
  );
}
