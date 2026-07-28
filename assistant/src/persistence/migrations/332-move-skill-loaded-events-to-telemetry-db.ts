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
 * How to drain `skill_loaded_events` from `main` into the telemetry DB.
 *
 * `copyWhere` is a liveness filter: only rows whose conversation still exists
 * (or that have none) are copied; the rest are purged without copying. The
 * table has per-conversation redaction semantics, and a drain can span boots —
 * the redaction paths delete only on the telemetry connection and cannot see
 * the staging table, so a conversation deleted mid-drain must not have its
 * staged rows resurrected on the next boot. The staging table and
 * `conversations` both live in `main`, so the predicate resolves there.
 */
export const SKILL_LOADED_EVENTS_RELOCATION: RelocationSpec = {
  table: "skill_loaded_events",
  targetDbPath: getTelemetryDbPath,
  copyWhere:
    "conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversations WHERE conversations.id = conversation_id)",
  columns: [
    "id",
    "created_at",
    "conversation_id",
    "skill_name",
    "skill_updated_at",
    "provider",
    "model",
    "inference_profile",
    "inference_profile_source",
  ],
};

const CREATE_TABLE = /*sql*/ `
  CREATE TABLE IF NOT EXISTS skill_loaded_events (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    conversation_id TEXT,
    skill_name TEXT NOT NULL,
    skill_updated_at TEXT,
    provider TEXT,
    model TEXT,
    inference_profile TEXT,
    inference_profile_source TEXT
  )
`;

/**
 * Create the `skill_loaded_events` table and its cursor index on the telemetry
 * connection. Idempotent (`IF NOT EXISTS`) — the dedicated connection itself
 * performs no DDL on open, so this migration owns the schema. The index backs
 * the telemetry reporter's compound `(created_at, id)` watermark cursor,
 * matching the main-DB original (migration 279).
 */
function ensureSkillLoadedEventsSchema(telemetryRaw: Database): void {
  telemetryRaw.exec(CREATE_TABLE);
  telemetryRaw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_skill_loaded_events_created_at_id ON skill_loaded_events (created_at, id)`,
  );
}

/**
 * Move `skill_loaded_events` — the `skill_loaded` telemetry outbox (one row
 * per Vellum-skill activation, metadata only) — into the dedicated telemetry
 * database (`assistant-telemetry.db`), alongside `watchdog_events`
 * (migration 301), `config_setting_events` (325), `onboarding_events` (329),
 * `auth_fallback_events` (330), and `lifecycle_events` (331). Rows are
 * inserted at activation time and read only by the usage telemetry reporter's
 * flush; housing them with the other telemetry tables keeps the main DB and
 * its WAL out of that write path. The store in
 * `telemetry/skill-loaded-events-store.ts` reads/writes it over the dedicated
 * telemetry connection (see `getTelemetryDb()`), and the reporter's
 * `(createdAt, id)` watermark in the main DB's checkpoints store survives the
 * move unchanged.
 *
 * Unlike the other moved outboxes this table has per-conversation redaction
 * semantics: deleting a conversation (or clearing all) must delete its
 * unshipped rows. Those cleanup paths (`conversation-crud.ts`,
 * `job-handlers/cleanup.ts`) delete over the telemetry connection too — which
 * cannot see rows parked in `main.skill_loaded_events__relocating` while a
 * drain is interrupted across boots. The spec's `copyWhere` liveness filter
 * closes that gap: on resume, rows whose conversation no longer exists are
 * purged instead of copied, so redacted rows never reach the telemetry DB.
 *
 * Like migrations 297/298/326/329/330/331 the move is incremental: create the
 * table (and index) on the telemetry connection, rename any populated
 * `main.skill_loaded_events` aside to `skill_loaded_events__relocating`, then
 * drain it in awaited batches (see `helpers/relocation.ts`) per
 * {@link SKILL_LOADED_EVENTS_RELOCATION}. On a fresh install the main-side
 * table created by migration 279 is empty, so staging just drops it.
 *
 * Throws (rather than returning) if the telemetry database cannot be opened,
 * so the runner records the step as failed instead of applied and retries it
 * on a later boot — never renaming the source aside without a target to write
 * to. The throw is caught per-step by the runner, so startup is not aborted.
 */
export async function migrateMoveSkillLoadedEventsToTelemetryDb(
  database: DrizzleDb,
): Promise<void> {
  const telemetryRaw = getTelemetrySqlite();
  if (!telemetryRaw) {
    throw new Error(
      "telemetry database unavailable — deferring skill_loaded_events relocation",
    );
  }

  ensureSkillLoadedEventsSchema(telemetryRaw);

  const raw = getSqliteFrom(database);
  const needsDrain = stageTableForRelocation(
    raw,
    SKILL_LOADED_EVENTS_RELOCATION.table,
  );

  if (needsDrain) {
    await drainStagedTable(raw, SKILL_LOADED_EVENTS_RELOCATION);
  }
}
