import { getTelemetrySqlite } from "../db-connection.js";

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS telemetry_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    conversation_id TEXT,
    payload TEXT NOT NULL
  )
`;

/**
 * Create `telemetry_events` — the generic telemetry outbox — on the dedicated
 * telemetry database (`assistant-telemetry.db`). Each row's `payload` holds
 * the wire `TelemetryEvent` JSON built at record time; the usage telemetry
 * reporter deletes rows after a successful flush. The `(name, created_at,
 * id)` index backs the per-source ordered batch reads; the `conversation_id`
 * index keeps conversation redaction an indexed delete. Idempotent
 * (`IF NOT EXISTS`); no main-DB work.
 *
 * Throws (rather than returning) if the telemetry database cannot be opened,
 * so the runner records the step as failed instead of applied and retries it
 * on a later boot. The throw is caught per-step by the runner, so startup is
 * not aborted.
 */
export function migrateCreateTelemetryEventsTable(): void {
  const telemetryRaw = getTelemetrySqlite();
  if (!telemetryRaw) {
    throw new Error(
      "telemetry database unavailable — deferring telemetry_events creation",
    );
  }

  telemetryRaw.exec(CREATE_TABLE);
  telemetryRaw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_telemetry_events_name_created_at_id ON telemetry_events (name, created_at, id)`,
  );
  telemetryRaw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_telemetry_events_conversation_id ON telemetry_events (conversation_id)`,
  );
}
