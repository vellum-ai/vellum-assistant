import type { DrizzleDb } from "../db-connection.js";

/**
 * Add skip_disclosure column to call_sessions so outbound calls can
 * skip the disclosure announcement on a per-call basis.
 */
export function migrateCallSessionSkipDisclosure(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE call_sessions ADD COLUMN skip_disclosure INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* already exists */
  }
}
