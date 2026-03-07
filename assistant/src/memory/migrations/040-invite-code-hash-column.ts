import type { DrizzleDb } from "../db-connection.js";

/**
 * Add invite_code_hash column to assistant_ingress_invites for 6-digit
 * invite code redemption on non-voice channels. The column is nullable —
 * voice invites use voice_code_hash instead.
 */
export function migrateInviteCodeHashColumn(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN invite_code_hash TEXT`,
    );
  } catch {
    /* already exists */
  }
}
