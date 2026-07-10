import type { Database } from "bun:sqlite";

import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import {
  type DrizzleDb,
  getSqliteFrom,
  getTelemetrySqlite,
} from "../db-connection.js";
import {
  drainStagedTable,
  type RelocationSpec,
  stageTableForRelocation,
} from "./helpers/relocation.js";

/**
 * How to drain `lifecycle_events` from `main` into the telemetry DB. The
 * table is a pure telemetry outbox — every row is worth keeping until the
 * usage telemetry reporter flushes it (and, by design, forever after: the
 * table is never deleted from) — so all rows are copied verbatim.
 */
export const LIFECYCLE_EVENTS_RELOCATION: RelocationSpec = {
  table: "lifecycle_events",
  targetDbPath: getTelemetryDbPath,
  columns: ["id", "event_name", "created_at"],
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS lifecycle_events (
    id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

/**
 * Create the `lifecycle_events` table and its cursor index on the telemetry
 * connection. Idempotent (`IF NOT EXISTS`) — the dedicated connection itself
 * performs no DDL on open, so this migration owns the schema. The index backs
 * the telemetry reporter's compound `(created_at, id)` watermark cursor,
 * matching `watchdog_events` (migration 301).
 */
function ensureLifecycleEventsSchema(telemetryRaw: Database): void {
  telemetryRaw.exec(CREATE_TABLE);
  telemetryRaw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_lifecycle_events_created_at_id ON lifecycle_events (created_at, id)`,
  );
}

/**
 * Move `lifecycle_events` — the app-lifecycle telemetry outbox (app_open,
 * hatch, permission prompts, watcher breadcrumbs, and the permanent
 * `conversations_clear_all` audit trail) — into the dedicated telemetry
 * database (`assistant-telemetry.db`), alongside `watchdog_events`
 * (migration 301), `config_setting_events` (migration 325),
 * `onboarding_events` (migration 327), and `auth_fallback_events`
 * (migration 328). Rows are inserted at emit time and read only by the usage
 * telemetry reporter's flush; housing them with the other telemetry tables
 * keeps the main DB and its WAL out of that write path. The store in
 * `persistence/lifecycle-events-store.ts` reads/writes it over the dedicated
 * telemetry connection (see `getTelemetryDb()`), and the reporter's
 * `(createdAt, id)` watermark in the main DB's checkpoints store survives the
 * move unchanged.
 *
 * Like migrations 297/298/326/327/328 the move is incremental: create the
 * table (and index) on the telemetry connection, rename any populated
 * `main.lifecycle_events` aside to `lifecycle_events__relocating`, then drain
 * it in awaited batches (see `helpers/relocation.ts`) per
 * {@link LIFECYCLE_EVENTS_RELOCATION}. On a fresh install the main-side table
 * created by migration 175 is empty, so staging just drops it.
 *
 * Throws (rather than returning) if the telemetry database cannot be opened,
 * so the runner records the step as failed instead of applied and retries it
 * on a later boot — never renaming the source aside without a target to write
 * to. The throw is caught per-step by the runner, so startup is not aborted.
 */
export async function migrateMoveLifecycleEventsToTelemetryDb(
  database: DrizzleDb,
): Promise<void> {
  const telemetryRaw = getTelemetrySqlite();
  if (!telemetryRaw) {
    throw new Error(
      "telemetry database unavailable — deferring lifecycle_events relocation",
    );
  }

  ensureLifecycleEventsSchema(telemetryRaw);

  const raw = getSqliteFrom(database);
  const needsDrain = stageTableForRelocation(
    raw,
    LIFECYCLE_EVENTS_RELOCATION.table,
  );

  if (needsDrain) {
    await drainStagedTable(raw, LIFECYCLE_EVENTS_RELOCATION);
  }
}
