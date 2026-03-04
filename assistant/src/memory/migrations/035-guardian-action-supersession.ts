import type { DrizzleDb } from "../db-connection.js";

/**
 * Add supersession metadata columns to guardian_action_requests and
 * create an index for efficient pending-request lookups by call session.
 *
 * - superseded_by_request_id: links to the request that replaced this one
 * - superseded_at: timestamp when supersession occurred
 * - Index (call_session_id, status, created_at DESC) for fast lookups of
 *   the most recent pending request per call session
 *
 * The existing expired_reason column already supports 'superseded' as a
 * value — this migration adds the structural metadata to track the
 * supersession chain.
 */
export function migrateGuardianActionSupersession(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN superseded_by_request_id TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE guardian_action_requests ADD COLUMN superseded_at INTEGER`,
    );
  } catch {
    /* already exists */
  }

  database.run(
    /*sql*/ `CREATE INDEX IF NOT EXISTS idx_guardian_action_requests_session_status_created ON guardian_action_requests(call_session_id, status, created_at DESC)`,
  );
}
