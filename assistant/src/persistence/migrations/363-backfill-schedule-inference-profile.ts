import type { Database } from "bun:sqlite";

import {
  resolveDefaultScheduleInferenceProfile,
  resolveWakeScheduleInferenceProfile,
} from "../../schedule/inference-profile.js";
import type { DurableProfileFields } from "../conversation-crud.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/** Columns a wake row's seed needs on `cron_jobs` and `conversations`. */
const WAKE_JOB_COLUMNS = ["mode", "wake_conversation_id"] as const;
const CONVERSATION_PIN_COLUMNS = [
  "conversation_type",
  "inference_profile",
  "inference_profile_session_id",
  "inference_profile_expires_at",
] as const;

function hasColumns(
  raw: Database,
  table: string,
  required: readonly string[],
): boolean {
  const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  const present = new Set(columns.map((c) => c.name));
  return required.every((name) => present.has(name));
}

/**
 * Pin every unpinned schedule to a concrete inference profile.
 *
 * A schedule with no pin follows `llm.activeProfile`, so changing the global
 * default silently moves every such schedule onto a different model and a
 * different price. Schedules created from now on snapshot a profile at write
 * time (`insertSchedule`); this backfill gives the rows that predate that the
 * same stability, on the profile they are running under today.
 *
 * "Running under today" is not the global default for every row. An unpinned
 * wake row reaches `buildWakeScheduleOptions` with no forced override, so its
 * firing resolves the target conversation's own pin live. Stamping the global
 * default over it would silently re-point a pending reminder that was created
 * inside a pinned conversation, so wake rows seed through the same
 * {@link resolveWakeScheduleInferenceProfile} the create path uses: the
 * target's durable pin, else the default. Every other row takes the default.
 *
 * Rows keep a NULL pin when no named profile resolves at all (the winner is
 * the code-owned anchor). That is the same value they carry now and resolves
 * identically at run time, through the `mainAgent` call-site configuration.
 *
 * Only `cron_jobs` is written. `conversations` carries a pin the user sets per
 * conversation (read here, never modified), and the telemetry tables
 * (tool_invocations, llm_usage_events, skill_loaded_events) carry an
 * `inference_profile` recording what actually ran, which must keep its
 * historical value.
 *
 * Idempotent: `WHERE inference_profile IS NULL` matches nothing once a row is
 * pinned, and the PRAGMA guards skip an install that has not created the
 * columns yet.
 */
export function migrateBackfillScheduleInferenceProfile(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  if (!hasColumns(raw, "cron_jobs", ["inference_profile"])) {
    return;
  }

  if (
    hasColumns(raw, "cron_jobs", WAKE_JOB_COLUMNS) &&
    hasColumns(raw, "conversations", CONVERSATION_PIN_COLUMNS)
  ) {
    backfillWakeRows(raw);
  }

  const profile = resolveDefaultScheduleInferenceProfile();
  if (profile === null) {
    return;
  }
  raw
    .prepare(
      `UPDATE cron_jobs SET inference_profile = ? WHERE inference_profile IS NULL`,
    )
    .run(profile);
}

function backfillWakeRows(raw: Database): void {
  const rows = raw
    .prepare(
      `SELECT id, wake_conversation_id AS wakeConversationId
         FROM cron_jobs
        WHERE inference_profile IS NULL
          AND mode = 'wake'
          AND wake_conversation_id IS NOT NULL`,
    )
    .all() as { id: string; wakeConversationId: string }[];
  if (rows.length === 0) {
    return;
  }

  const selectTarget = raw.prepare(
    `SELECT conversation_type AS conversationType,
            inference_profile AS inferenceProfile,
            inference_profile_session_id AS inferenceProfileSessionId,
            inference_profile_expires_at AS inferenceProfileExpiresAt
       FROM conversations
      WHERE id = ?`,
  );
  const pin = raw.prepare(
    `UPDATE cron_jobs SET inference_profile = ? WHERE id = ? AND inference_profile IS NULL`,
  );

  for (const row of rows) {
    // A target deleted since the wake was created reads as null and falls
    // through to the default, the same value the firing would resolve.
    const target =
      (selectTarget.get(
        row.wakeConversationId,
      ) as DurableProfileFields | null) ?? null;
    const profile = resolveWakeScheduleInferenceProfile(target);
    if (profile === null) {
      continue;
    }
    pin.run(profile, row.id);
  }
}
