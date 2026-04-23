import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateScheduleWakeConversationId(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(`ALTER TABLE cron_jobs ADD COLUMN wake_conversation_id TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }
}
