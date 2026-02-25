import type { DrizzleDb } from '../db-connection.js';

/**
 * Add composite indexes on (conversation_id, status) for task_runs and
 * cron_runs. The isConversationFailed query filters on both columns via a
 * UNION ALL — without these indexes each branch requires a full table scan.
 */
export function migrateConversationStatusIndexes(database: DrizzleDb): void {
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_task_runs_conversation_status ON task_runs(conversation_id, status)`);
  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_cron_runs_conversation_status ON cron_runs(conversation_id, status)`);
}
