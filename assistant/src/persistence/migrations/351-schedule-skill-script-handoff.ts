import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add the script-handoff and skill-binding columns to `cron_jobs`.
 *
 * - `then_execute` — when set on a script-mode schedule, the firing hands the
 *   script's stdout to an agent turn instead of only recording it on the run
 *   row. Defaults to 0 so every pre-existing script schedule keeps its
 *   no-LLM behaviour.
 * - `skill_id` — the managed skill whose `scripts/` the command invokes. NULL
 *   (all pre-existing rows) means the schedule is not bound to a skill.
 * - `skill_version_hash` — the skill's content hash at creation time,
 *   re-checked before each firing so a rewritten script cannot keep running
 *   under the original approval.
 *
 * Idempotent — the PRAGMA guard makes re-running a no-op once the columns
 * exist.
 */
export function migrateScheduleSkillScriptHandoff(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw.query(`PRAGMA table_info(cron_jobs)`).all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("then_execute")) {
    raw.exec(
      `ALTER TABLE cron_jobs ADD COLUMN then_execute INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!columnNames.has("skill_id")) {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN skill_id TEXT`);
  }
  if (!columnNames.has("skill_version_hash")) {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN skill_version_hash TEXT`);
  }
}
