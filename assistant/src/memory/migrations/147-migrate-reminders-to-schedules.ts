import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Migrate all existing reminders into the cron_jobs (schedules) table as
 * one-shot schedules.
 *
 * Field mapping:
 *   reminder.label          → cron_jobs.name
 *   reminder.message        → cron_jobs.message
 *   reminder.fire_at        → cron_jobs.next_run_at
 *   reminder.fired_at       → cron_jobs.last_run_at
 *   reminder.mode           → cron_jobs.mode
 *   reminder.routing_intent → cron_jobs.routing_intent
 *   reminder.routing_hints_json → cron_jobs.routing_hints_json
 *   reminder.created_at     → cron_jobs.created_at
 *   reminder.updated_at     → cron_jobs.updated_at
 *
 * Status mapping:
 *   pending   → active
 *   firing    → firing
 *   fired     → fired
 *   cancelled → cancelled
 *
 * Enabled: pending → 1, all others → 0
 *
 * last_status: fired → 'ok', others → NULL
 *
 * One-shot schedules have NULL cron_expression. The reminders table is
 * preserved for the subsequent cleanup PR.
 */
export function migrateRemindersToSchedules(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_reminders_to_schedules_v1", () => {
    const raw = getSqliteFrom(database);

    // Guard: if the reminders table doesn't exist, nothing to migrate.
    const hasReminders = raw
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reminders'",
      )
      .get();
    if (!hasReminders) return;

    // Read all reminders into memory. We use the reminder's original ID as
    // the cron_jobs primary key so that INSERT OR IGNORE deduplicates
    // correctly if the migration re-runs after a crash.
    const reminders = raw.query("SELECT * FROM reminders").all() as Array<{
      id: string;
      label: string;
      message: string;
      fire_at: number;
      mode: string;
      status: string;
      fired_at: number | null;
      routing_intent: string;
      routing_hints_json: string;
      created_at: number;
      updated_at: number;
    }>;

    if (reminders.length === 0) return;

    const insert = raw.query(/*sql*/ `
        INSERT OR IGNORE INTO cron_jobs (
          id, name, enabled, cron_expression, schedule_syntax, timezone,
          message, next_run_at, last_run_at, last_status, retry_count,
          created_by, mode, routing_intent, routing_hints_json, status,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, NULL, 'cron', NULL,
          ?, ?, ?, ?, 0,
          'agent', ?, ?, ?, ?,
          ?, ?
        )
      `);

    // Mark migrated pending reminders as fired so the legacy
    // claimDueReminders path doesn't fire them a second time.
    const markFired = raw.query(/*sql*/ `
        UPDATE reminders SET status = 'fired', fired_at = ?
        WHERE id = ? AND status = 'pending'
      `);

    try {
      raw.exec("BEGIN");

      for (const r of reminders) {
        const statusMap: Record<string, string> = {
          pending: "active",
          firing: "firing",
          fired: "fired",
          cancelled: "cancelled",
        };

        insert.run(
          r.id,
          r.label,
          r.status === "pending" ? 1 : 0,
          // message, next_run_at, last_run_at, last_status
          r.message,
          r.fire_at,
          r.fired_at,
          r.status === "fired" ? "ok" : null,
          // mode, routing_intent, routing_hints_json, status
          r.mode,
          r.routing_intent,
          r.routing_hints_json,
          statusMap[r.status] ?? "active",
          // created_at, updated_at
          r.created_at,
          r.updated_at,
        );

        if (r.status === "pending") {
          markFired.run(Date.now(), r.id);
        }
      }

      raw.exec("COMMIT");
    } catch (err) {
      raw.exec("ROLLBACK");
      throw err;
    }
  });
}
