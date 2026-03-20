import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Drop the legacy reminders table and its index now that all data has been
 * migrated into cron_jobs as one-shot schedules (migration 147).
 */
export function migrateDropRemindersTable(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_drop_reminders_table_v1", () => {
    const raw = getSqliteFrom(database);
    raw.run("DROP INDEX IF EXISTS idx_reminders_status_fire_at");
    raw.run("DROP TABLE IF EXISTS reminders");
  });
}
