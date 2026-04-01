import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add reuse_conversation column to cron_jobs so recurring schedules can
 * opt in to reusing the most recent conversation instead of creating a
 * new one on every run.
 *
 * Boolean INTEGER — defaults to 0 (false) for backward compatibility.
 */
export function migrateScheduleReuseConversation(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  if (!tableHasColumn(database, "cron_jobs", "reuse_conversation")) {
    raw.exec(
      /*sql*/ `ALTER TABLE cron_jobs ADD COLUMN reuse_conversation INTEGER NOT NULL DEFAULT 0`,
    );
  }
}
