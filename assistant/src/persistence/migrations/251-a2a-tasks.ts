import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Create the a2a_tasks table for tracking A2A request/response lifecycle.
 *
 * Each row represents one inbound A2A task, tracking its state machine
 * progression through submitted -> working -> completed/failed/canceled/rejected.
 */
export function migrateA2ATasks(database: DrizzleDb): void {
  if (tableHasColumn(database, "a2a_tasks", "id")) {
    return;
  }
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS a2a_tasks (
      id TEXT PRIMARY KEY,
      context_id TEXT,
      conversation_id TEXT,
      state TEXT NOT NULL DEFAULT 'submitted',
      status_message TEXT,
      request_message_json TEXT NOT NULL,
      artifacts_json TEXT,
      push_url TEXT,
      sender_assistant_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context
      ON a2a_tasks (context_id)
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_conversation
      ON a2a_tasks (conversation_id)
  `);
}

export function downA2ATasks(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `DROP TABLE IF EXISTS a2a_tasks`);
}
