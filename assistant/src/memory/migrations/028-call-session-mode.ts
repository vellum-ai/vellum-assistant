import type { DrizzleDb } from '../db-connection.js';

/**
 * Add call_mode and guardian_verification_session_id columns to call_sessions.
 *
 * call_mode is the persisted source of truth for deterministic flow selection
 * in the relay server. guardian_verification_session_id links the call session
 * to the verification session for observability.
 */
export function migrateCallSessionMode(database: DrizzleDb): void {
  try { database.run(/*sql*/ `ALTER TABLE call_sessions ADD COLUMN call_mode TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE call_sessions ADD COLUMN guardian_verification_session_id TEXT`); } catch { /* already exists */ }
}
