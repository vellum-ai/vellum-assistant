import type { DrizzleDb } from '../db-connection.js';

/**
 * Add follow-up lifecycle columns to guardian_action_requests.
 *
 * These columns track why a request expired (expired_reason), the
 * post-timeout follow-up state machine (followup_state), and any
 * late answer that arrived after the timeout.
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency.
 */
export function migrateGuardianActionFollowup(database: DrizzleDb): void {
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN expired_reason TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN followup_state TEXT NOT NULL DEFAULT 'none'`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN late_answer_text TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN late_answered_at INTEGER`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN followup_action TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN followup_completed_at INTEGER`); } catch { /* already exists */ }

  database.run(/*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_followup_state ON guardian_action_requests(followup_state)`);
}
