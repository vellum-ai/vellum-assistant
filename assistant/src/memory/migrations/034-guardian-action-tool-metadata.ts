import type { DrizzleDb } from '../db-connection.js';

/**
 * Add tool_name and input_digest columns to guardian_action_requests for
 * structured tool-approval tracking. These are nullable — informational
 * ASK_GUARDIAN requests leave them NULL while tool-approval requests
 * carry the tool identity and canonical input digest.
 */
export function migrateGuardianActionToolMetadata(database: DrizzleDb): void {
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN tool_name TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN input_digest TEXT`); } catch { /* already exists */ }
}
