import type { DrizzleDb } from '../db-connection.js';

/**
 * Add voice invite columns to assistant_ingress_invites for guardian-initiated
 * voice invite codes. All columns are nullable to keep existing invite rows
 * compatible.
 *
 * - expected_external_user_id: E.164 phone number for identity binding
 * - voice_code_hash: SHA-256 hash of the short numeric code
 * - voice_code_digits: configurable digit count (default 6)
 */
export function migrateVoiceInviteColumns(database: DrizzleDb): void {
  try { database.run(/*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN expected_external_user_id TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN voice_code_hash TEXT`); } catch { /* already exists */ }
  try { database.run(/*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN voice_code_digits INTEGER DEFAULT 6`); } catch { /* already exists */ }
}
