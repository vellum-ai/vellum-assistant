import type { DrizzleDb } from "../db-connection.js";

/**
 * Add invite metadata columns to call_sessions so outbound invite calls
 * can persist friend/guardian names for deterministic routing in the
 * relay setup router (mirroring how verification_session_id works for
 * guardian verification calls).
 */
export function migrateCallSessionInviteMetadata(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE call_sessions ADD COLUMN invite_friend_name TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE call_sessions ADD COLUMN invite_guardian_name TEXT`,
    );
  } catch {
    /* already exists */
  }
}
