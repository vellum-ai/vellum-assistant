import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

const TABLE = "client_connection_events";

/**
 * Create `client_connection_events`: the durable hub subscribe/dispose
 * ledger used by `assistant clients history`.
 *
 * One row per client-subscriber lifecycle event. Reconnects shorter than
 * the flap window are coalesced at read time, not at write time, so the
 * raw event stream stays a complete audit.
 *
 * Idempotent via IF NOT EXISTS.
 */
export function migrateCreateClientConnectionEvents(database: DrizzleDb): void {
  const sqlite = getSqliteFrom(database);
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       id TEXT PRIMARY KEY,
       client_id TEXT NOT NULL,
       interface_id TEXT NOT NULL,
       connection_id TEXT NOT NULL,
       reason TEXT NOT NULL,
       occurred_at INTEGER NOT NULL,
       actor_principal_id TEXT,
       client_version TEXT,
       sse_watchdog INTEGER,
       machine_name TEXT
     )`,
  );
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_client_connection_events_client_occurred
       ON ${TABLE} (client_id, occurred_at)`,
  );
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_client_connection_events_occurred
       ON ${TABLE} (occurred_at)`,
  );
}
