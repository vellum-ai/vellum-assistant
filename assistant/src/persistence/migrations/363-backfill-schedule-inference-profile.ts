import { resolveDefaultScheduleInferenceProfile } from "../../schedule/inference-profile.js";
import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Pin every unpinned schedule to the currently resolved default inference
 * profile.
 *
 * A schedule with no pin follows `llm.activeProfile`, so changing the global
 * default silently moves every such schedule onto a different model and a
 * different price. Schedules created from now on snapshot the resolved default
 * at write time (`insertSchedule`); this backfill gives the rows that predate
 * that the same stability, on the profile they are running under today.
 *
 * Rows keep a NULL pin when no named profile resolves at all (the winner is
 * the code-owned anchor). That is the same value they carry now and resolves
 * identically at run time, through the `mainAgent` call-site configuration.
 *
 * Only `cron_jobs` is touched. `conversations` carries a pin the user sets per
 * conversation, and the telemetry tables (tool_invocations, llm_usage_events,
 * skill_loaded_events) carry an `inference_profile` recording what actually
 * ran, which must keep its historical value.
 *
 * Idempotent: `WHERE inference_profile IS NULL` matches nothing once a row is
 * pinned, and the PRAGMA guard skips an install that has not created the
 * column yet.
 */
export function migrateBackfillScheduleInferenceProfile(
  database: DrizzleDb,
): void {
  const profile = resolveDefaultScheduleInferenceProfile();
  if (profile === null) {
    return;
  }

  const raw = getSqliteFrom(database);
  const columns = raw.prepare(`PRAGMA table_info(cron_jobs)`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === "inference_profile")) {
    return;
  }

  raw
    .prepare(
      `UPDATE cron_jobs SET inference_profile = ? WHERE inference_profile IS NULL`,
    )
    .run(profile);
}
