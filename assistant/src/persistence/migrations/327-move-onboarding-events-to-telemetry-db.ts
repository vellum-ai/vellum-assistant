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
 * How to drain `onboarding_events` from `main` into the telemetry DB. The
 * table is a pure telemetry outbox — every row is worth keeping until the
 * usage telemetry reporter flushes it — so all rows are copied verbatim.
 */
export const ONBOARDING_EVENTS_RELOCATION: RelocationSpec = {
  table: "onboarding_events",
  targetDbPath: getTelemetryDbPath,
  columns: [
    "id",
    "created_at",
    "screen",
    "tools_json",
    "tasks_json",
    "tone",
    "google_connected",
    "google_scopes_json",
    "prior_assistants_json",
    "ab_variant",
    "session_id",
    "step_name",
    "step_index",
    "completed_at",
    "funnel_version",
  ],
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS onboarding_events (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    screen TEXT NOT NULL,
    tools_json TEXT,
    tasks_json TEXT,
    tone TEXT,
    google_connected INTEGER,
    google_scopes_json TEXT,
    prior_assistants_json TEXT,
    ab_variant TEXT,
    session_id TEXT,
    step_name TEXT,
    step_index INTEGER,
    completed_at TEXT,
    funnel_version TEXT
  )
`;

/**
 * Create the `onboarding_events` table and its cursor index on the telemetry
 * connection. Idempotent (`IF NOT EXISTS`) — the dedicated connection itself
 * performs no DDL on open, so this migration owns the schema. The index backs
 * the telemetry reporter's compound `(created_at, id)` watermark cursor,
 * matching `watchdog_events` (migration 301).
 */
function ensureOnboardingEventsSchema(telemetryRaw: Database): void {
  telemetryRaw.exec(CREATE_TABLE);
  telemetryRaw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_onboarding_events_created_at_id ON onboarding_events (created_at, id)`,
  );
}

/**
 * Move `onboarding_events` — the onboarding/activation-funnel telemetry
 * outbox — into the dedicated telemetry database (`assistant-telemetry.db`),
 * alongside `watchdog_events` (migration 301) and `config_setting_events`
 * (migration 325). Rows are inserted at emit time and read only by the usage
 * telemetry reporter's flush; housing them with the other telemetry tables
 * keeps the main DB and its WAL out of that write path. The store in
 * `onboarding/onboarding-events-store.ts` reads/writes it over the dedicated
 * telemetry connection (see `getTelemetryDb()`), and the reporter's
 * `(createdAt, id)` watermark in the main DB's checkpoints store survives the
 * move unchanged.
 *
 * Like migrations 297/298/326 the move is incremental: create the table (and
 * index) on the telemetry connection, rename any populated
 * `main.onboarding_events` aside to `onboarding_events__relocating`, then
 * drain it in awaited batches (see `helpers/relocation.ts`) per
 * {@link ONBOARDING_EVENTS_RELOCATION}. On a fresh install the main-side
 * table created by migration 248 is empty, so staging just drops it.
 *
 * Throws (rather than returning) if the telemetry database cannot be opened,
 * so the runner records the step as failed instead of applied and retries it
 * on a later boot — never renaming the source aside without a target to write
 * to. The throw is caught per-step by the runner, so startup is not aborted.
 */
export async function migrateMoveOnboardingEventsToTelemetryDb(
  database: DrizzleDb,
): Promise<void> {
  const telemetryRaw = getTelemetrySqlite();
  if (!telemetryRaw) {
    throw new Error(
      "telemetry database unavailable — deferring onboarding_events relocation",
    );
  }

  ensureOnboardingEventsSchema(telemetryRaw);

  const raw = getSqliteFrom(database);
  const needsDrain = stageTableForRelocation(
    raw,
    ONBOARDING_EVENTS_RELOCATION.table,
  );

  if (needsDrain) await drainStagedTable(raw, ONBOARDING_EVENTS_RELOCATION);
}
