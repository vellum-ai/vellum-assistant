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
 * How to drain `auth_fallback_events` from `main` into the telemetry DB. The
 * table is a pure telemetry outbox — every row is worth keeping until the
 * usage telemetry reporter flushes it — so all rows are copied verbatim.
 */
const AUTH_FALLBACK_EVENTS_RELOCATION: RelocationSpec = {
  table: "auth_fallback_events",
  targetDbPath: getTelemetryDbPath,
  columns: [
    "id",
    "created_at",
    "guard",
    "path",
    "failure_kind",
    "count",
    "window_start",
    "window_end",
  ],
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS auth_fallback_events (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    guard TEXT NOT NULL,
    path TEXT NOT NULL,
    failure_kind TEXT NOT NULL,
    count INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL
  )
`;

/**
 * Create the `auth_fallback_events` table and its cursor index on the
 * telemetry connection. Idempotent (`IF NOT EXISTS`) — the dedicated
 * connection itself performs no DDL on open, so this migration owns the
 * schema. The index backs the telemetry reporter's compound `(created_at, id)`
 * watermark cursor, matching `watchdog_events` (migration 301).
 */
function ensureAuthFallbackEventsSchema(telemetryRaw: Database): void {
  telemetryRaw.exec(CREATE_TABLE);
  telemetryRaw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_auth_fallback_events_created_at_id ON auth_fallback_events (created_at, id)`,
  );
}

/**
 * Move `auth_fallback_events` — the aggregated legacy-loopback auth-fallback
 * telemetry outbox — into the dedicated telemetry database
 * (`assistant-telemetry.db`), alongside `watchdog_events` (migration 301),
 * `config_setting_events` (migration 325), and `onboarding_events`
 * (migration 329). Rows are inserted at emit time (counts forwarded by the
 * gateway) and read only by the usage telemetry reporter's flush; housing
 * them with the other telemetry tables keeps the main DB and its WAL out of
 * that write path. The store in `security/auth-fallback-events-store.ts`
 * reads/writes it over the dedicated telemetry connection (see
 * `getTelemetryDb()`), and the reporter's `(createdAt, id)` watermark in the
 * main DB's checkpoints store survives the move unchanged.
 *
 * Like migrations 297/298/326/329 the move is incremental: create the table
 * (and index) on the telemetry connection, rename any populated
 * `main.auth_fallback_events` aside to `auth_fallback_events__relocating`,
 * then drain it in awaited batches (see `helpers/relocation.ts`) per
 * {@link AUTH_FALLBACK_EVENTS_RELOCATION}. On a fresh install the main-side
 * table created by migration 271 is empty, so staging just drops it.
 *
 * Throws (rather than returning) if the telemetry database cannot be opened,
 * so the runner records the step as failed instead of applied and retries it
 * on a later boot — never renaming the source aside without a target to write
 * to. The throw is caught per-step by the runner, so startup is not aborted.
 */
export async function migrateMoveAuthFallbackEventsToTelemetryDb(
  database: DrizzleDb,
): Promise<void> {
  const telemetryRaw = getTelemetrySqlite();
  if (!telemetryRaw) {
    throw new Error(
      "telemetry database unavailable — deferring auth_fallback_events relocation",
    );
  }

  ensureAuthFallbackEventsSchema(telemetryRaw);

  const raw = getSqliteFrom(database);
  const needsDrain = stageTableForRelocation(
    raw,
    AUTH_FALLBACK_EVENTS_RELOCATION.table,
  );

  if (needsDrain) {
    await drainStagedTable(raw, AUTH_FALLBACK_EVENTS_RELOCATION);
  }
}
