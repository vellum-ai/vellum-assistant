import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
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

/**
 * Reverse: recreate the reminders table with its original schema.
 *
 * Data is permanently lost — the table was dropped. This only restores the
 * empty table structure so that earlier migrations referencing it can operate.
 * Includes the routing_intent and routing_hints_json columns added by
 * migration 118.
 */
export function migrateDropRemindersTableDown(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      message TEXT NOT NULL,
      fire_at INTEGER NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      fired_at INTEGER,
      conversation_id TEXT,
      routing_intent TEXT NOT NULL DEFAULT 'all_channels',
      routing_hints_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_reminders_status_fire_at ON reminders(status, fire_at)`,
  );
}
