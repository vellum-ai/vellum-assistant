import type { DrizzleDb } from "../db-connection.js";

/**
 * Rename assistant_inbox_thread_state -> assistant_inbox_conversation_state
 * as part of the thread -> conversation terminology unification.
 */
export function migrateRenameInboxThreadStateTable(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE assistant_inbox_thread_state RENAME TO assistant_inbox_conversation_state`,
    );
  } catch {
    /* already renamed */
  }
}
