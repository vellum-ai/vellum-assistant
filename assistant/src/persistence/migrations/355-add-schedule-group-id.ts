import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add `group_id` column to the `cron_jobs` table.
 *
 * The column holds a `conversation_groups` id; conversations created by the
 * schedule's runs are filed into that sidebar group instead of the default
 * `system:scheduled`. NULL keeps the default. The consumer
 * (`resolveScheduleConversationGroupId` in `schedule-store.ts`) falls back to
 * `system:scheduled` when the referenced group no longer exists, so no
 * backfill or FK is needed.
 *
 * Idempotent: the ALTER is guarded with `tableHasColumn` so a crash between
 * the `ALTER TABLE` and the checkpoint write doesn't cause a duplicate-column
 * error on the next boot.
 */
export function migrateAddScheduleGroupId(database: DrizzleDb): void {
  if (!tableHasColumn(database, "cron_jobs", "group_id")) {
    database.run(`ALTER TABLE cron_jobs ADD COLUMN group_id TEXT`);
  }
}
