import type { DrizzleDb } from '../db-connection.js';

/**
 * Add verification_purpose column to channel_guardian_verification_challenges.
 * Distinguishes guardian outbound verification from trusted contact verification
 * so the consume path knows whether to create a guardian binding.
 *
 * Uses ALTER TABLE ADD COLUMN which is a no-op if the column already
 * exists (caught by try/catch).
 */
export function migrateGuardianVerificationPurpose(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE channel_guardian_verification_challenges ADD COLUMN verification_purpose TEXT DEFAULT 'guardian'`,
    );
  } catch { /* already exists */ }
}
