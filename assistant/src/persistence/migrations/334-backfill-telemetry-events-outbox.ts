import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import { getTelemetryDbPath } from "../../util/telemetry-db-path.js";
import { APP_VERSION } from "../../version.js";
import { type DrizzleDb, getTelemetrySqlite } from "../db-connection.js";

const log = getLogger("migration-334");

/** Rows per multi-row INSERT — stays under SQLite's bound-variable limit. */
const INSERT_CHUNK_SIZE = 500;

type LegacyRow = Record<string, string | number | null>;

/**
 * One legacy per-type telemetry table to fold into the `telemetry_events`
 * outbox. `sourceId` is the reporter watermark namespace
 * (`telemetry:<sourceId>:last_reported_{at,id}` in `flush_checkpoints`);
 * `toPayload` is a frozen copy of the source's pre-outbox flush-time wire
 * mapper (deliberately NOT shared with the live store code, so later store
 * changes cannot rewrite what this migration produces).
 */
interface LegacyBackfillSpec {
  table: string;
  sourceId: string;
  /** Column copied into `telemetry_events.conversation_id` (redaction index). */
  conversationIdColumn?: string;
  toPayload(row: LegacyRow): Record<string, unknown>;
}

/** `{ [key]: JSON.parse(raw) }` when `raw` is parseable JSON text; else `{}`. */
function jsonField(
  key: string,
  raw: string | number | null,
): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") {
    return {};
  }
  try {
    return { [key]: JSON.parse(raw) };
  } catch {
    return {};
  }
}

/** Stored watchdog `detail` JSON text → object bag; null/corrupt/non-object → null. */
function parseWatchdogDetail(
  raw: string | number | null,
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

const LEGACY_BACKFILL_SPECS: readonly LegacyBackfillSpec[] = [
  {
    table: "lifecycle_events",
    sourceId: "lifecycle",
    toPayload: (row) => ({
      type: "lifecycle",
      daemon_event_id: row.id,
      event_name: row.event_name,
      recorded_at: row.created_at,
      assistant_version: APP_VERSION,
    }),
  },
  {
    table: "onboarding_events",
    sourceId: "onboarding",
    toPayload: (row) => ({
      type: "onboarding",
      // Activation rows carry a deterministic wire id keyed on the row's own
      // funnel_version/session/step so dbt collapses a moment that fires more
      // than once; every other row uses the row id.
      daemon_event_id:
        row.session_id && row.step_name && row.funnel_version
          ? `${row.funnel_version}:${row.session_id}:${row.step_name}`
          : row.id,
      recorded_at: row.created_at,
      screen: row.screen,
      // Optional fields are omit-when-absent; a corrupt stored JSON column
      // omits just that field (the row still backfills). The never-shipped
      // `prior_assistants_json` column is dropped here.
      ...jsonField("tools", row.tools_json),
      ...jsonField("tasks", row.tasks_json),
      ...(row.tone ? { tone: row.tone } : {}),
      ...(row.google_connected != null
        ? { google_connected: row.google_connected !== 0 }
        : {}),
      ...jsonField("google_scopes", row.google_scopes_json),
      ...(row.ab_variant ? { ab_variant: row.ab_variant } : {}),
      ...(row.session_id ? { session_id: row.session_id } : {}),
      ...(row.step_name ? { step_name: row.step_name } : {}),
      ...(row.step_index != null ? { step_index: row.step_index } : {}),
      ...(row.completed_at ? { completed_at: row.completed_at } : {}),
      ...(row.funnel_version ? { funnel_version: row.funnel_version } : {}),
      assistant_version: APP_VERSION,
    }),
  },
  {
    table: "auth_fallback_events",
    sourceId: "auth_fallback",
    toPayload: (row) => ({
      type: "auth_fallback",
      daemon_event_id: row.id,
      recorded_at: row.created_at,
      guard: row.guard,
      path: row.path,
      failure_kind: row.failure_kind,
      count: row.count,
      window_start: row.window_start,
      window_end: row.window_end,
      assistant_version: APP_VERSION,
    }),
  },
  {
    table: "skill_loaded_events",
    sourceId: "skill_loaded",
    conversationIdColumn: "conversation_id",
    toPayload: (row) => ({
      type: "skill_loaded",
      daemon_event_id: row.id,
      recorded_at: row.created_at,
      skill_name: row.skill_name,
      skill_updated_at: row.skill_updated_at,
      conversation_id: row.conversation_id,
      provider: row.provider,
      model: row.model,
      inference_profile: row.inference_profile,
      inference_profile_source: row.inference_profile_source,
      assistant_version: APP_VERSION,
    }),
  },
  {
    table: "watchdog_events",
    sourceId: "watchdog",
    toPayload: (row) => ({
      type: "watchdog",
      daemon_event_id: row.id,
      recorded_at: row.created_at,
      check_name: row.check_name,
      value: row.value,
      detail: parseWatchdogDetail(row.detail),
      assistant_version: APP_VERSION,
    }),
  },
  {
    table: "config_setting_events",
    sourceId: "config_setting",
    toPayload: (row) => ({
      type: "config_setting",
      daemon_event_id: row.id,
      recorded_at: row.created_at,
      config_key: row.config_key,
      config_value: row.config_value,
      assistant_version: APP_VERSION,
    }),
  },
];

function tableExists(raw: Database, table: string): boolean {
  return (
    raw
      .query(
        /*sql*/ `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(table) != null
  );
}

/**
 * Rows the reporter has NOT yet shipped, per the source's `flush_checkpoints`
 * watermark: the standard compound cursor when both keys exist (the opt-out
 * `ffffffff-…` id sentinel composes correctly — nothing at the pinned
 * timestamp sorts above it), timestamp-only when only `at` exists, and ALL
 * rows when the watermark is absent or unreadable (never-flushed installs).
 */
function selectUnshippedRows(
  raw: Database,
  spec: LegacyBackfillSpec,
): LegacyRow[] {
  const keyPrefix = `telemetry:${spec.sourceId}:last_reported`;
  const checkpoint = raw.query(
    /*sql*/ `SELECT value FROM flush_checkpoints WHERE key = ?`,
  );
  const atValue = (
    checkpoint.get(`${keyPrefix}_at`) as { value: string } | null
  )?.value;
  const at = atValue != null ? Number(atValue) : null;
  const id = (checkpoint.get(`${keyPrefix}_id`) as { value: string } | null)
    ?.value;

  const base = /*sql*/ `SELECT * FROM ${spec.table}`;
  const order = /*sql*/ ` ORDER BY created_at, id`;
  if (at == null || !Number.isFinite(at)) {
    return raw.query(base + order).all() as LegacyRow[];
  }
  if (id != null) {
    return raw
      .query(
        base +
          /*sql*/ ` WHERE created_at > ? OR (created_at = ? AND id > ?)` +
          order,
      )
      .all(at, at, id) as LegacyRow[];
  }
  return raw
    .query(base + /*sql*/ ` WHERE created_at > ?` + order)
    .all(at) as LegacyRow[];
}

function insertOutboxRows(
  raw: Database,
  spec: LegacyBackfillSpec,
  rows: LegacyRow[],
): void {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((row) => [
      row.id,
      spec.sourceId,
      row.created_at,
      spec.conversationIdColumn
        ? (row[spec.conversationIdColumn] ?? null)
        : null,
      JSON.stringify(spec.toPayload(row)),
    ]);
    raw
      .query(
        /*sql*/ `INSERT OR IGNORE INTO telemetry_events (id, name, created_at, conversation_id, payload) VALUES ${placeholders}`,
      )
      .run(...params);
  }
}

/**
 * Fold the six legacy per-type telemetry tables (`lifecycle_events`,
 * `onboarding_events`, `auth_fallback_events`, `skill_loaded_events`,
 * `watchdog_events`, `config_setting_events`) into the generic
 * `telemetry_events` outbox (migration 333) and drop them, entirely on the
 * telemetry database (`assistant-telemetry.db`).
 *
 * For each table (skipping any absent from `sqlite_master`): select the rows
 * the reporter's `flush_checkpoints` watermark marks as unshipped, map each to
 * its wire `TelemetryEvent` with the frozen mappers above (record-time
 * payloads, `assistant_version: APP_VERSION` — the same stamp flush-time
 * mapping would have produced), `INSERT OR IGNORE` them into
 * `telemetry_events` (idempotent under a re-run after a partial crash), and
 * drop the legacy table. `conversation_id` is populated only from
 * `skill_loaded_events`, keeping conversation redaction an indexed delete.
 * Finally the six sources' now-meaningless watermark keys are purged from
 * `flush_checkpoints` (ack-mode sources delete rows instead of advancing
 * cursors); the table itself survives for the main-DB-backed watermark
 * sources (`usage`, `turns`, `tool_executed`).
 *
 * The `mainDb` parameter is accepted to satisfy the migration-step signature
 * but is not used — this migration operates exclusively on the telemetry DB.
 */
export function migrateBackfillTelemetryEventsOutbox(_mainDb: DrizzleDb): void {
  let raw: Database | null = getTelemetrySqlite();
  if (!raw) {
    // The dedicated connection failed to open (logged by openDedicatedDb).
    // Fall back to opening the file directly so the migration still runs —
    // the singleton will pick it up on a later access. This mirrors the
    // fail-soft pattern of the other dedicated-DB migrations.
    raw = new Database(getTelemetryDbPath());
  }

  const backfilled: Record<string, number> = {};
  for (const spec of LEGACY_BACKFILL_SPECS) {
    if (!tableExists(raw, spec.table)) {
      continue;
    }
    const rows = selectUnshippedRows(raw, spec);
    insertOutboxRows(raw, spec, rows);
    raw.exec(/*sql*/ `DROP TABLE ${spec.table}`);
    backfilled[spec.table] = rows.length;
  }

  const watermarkKeys = LEGACY_BACKFILL_SPECS.flatMap((spec) => [
    `telemetry:${spec.sourceId}:last_reported_at`,
    `telemetry:${spec.sourceId}:last_reported_id`,
  ]);
  raw
    .query(
      /*sql*/ `DELETE FROM flush_checkpoints WHERE key IN (${watermarkKeys.map(() => "?").join(", ")})`,
    )
    .run(...watermarkKeys);

  log.info(
    { backfilled },
    "Backfilled unshipped legacy telemetry rows into telemetry_events and dropped the legacy tables",
  );
}
