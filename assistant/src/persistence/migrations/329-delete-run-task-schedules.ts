import type { DrizzleDb } from "../db-connection.js";

/**
 * Delete schedule rows that invoke a saved task template.
 *
 * The task-template / task-queue subsystem has been removed. Schedules created
 * against it stored a `run_task:<taskId>` message that the scheduler special-
 * cased to run the template. With that execution branch gone, such a schedule
 * would instead send the literal string `run_task:<taskId>` to the assistant
 * as a prompt on every fire. These schedules reference a capability that no
 * longer exists, so remove them outright.
 *
 * `cron_runs` rows for a deleted job are removed first so the cleanup does not
 * depend on the `foreign_keys` pragma being ON during migration.
 *
 * Idempotent: once the `run_task:` rows are gone, re-running deletes nothing.
 */
export function migrateDeleteRunTaskSchedules(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `DELETE FROM cron_runs WHERE job_id IN (SELECT id FROM cron_jobs WHERE message LIKE 'run_task:%')`,
    );
  } catch {
    /* table absent */
  }
  try {
    database.run(
      /*sql*/ `DELETE FROM cron_jobs WHERE message LIKE 'run_task:%'`,
    );
  } catch {
    /* table absent */
  }
}
