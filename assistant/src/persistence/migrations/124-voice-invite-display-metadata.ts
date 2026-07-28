import type { DrizzleDb } from "../db-connection.js";

/**
 * Add display metadata columns to assistant_ingress_invites for personalized
 * voice invite prompts. Both columns are nullable to keep existing invite
 * rows compatible.
 *
 * - friend_name: the name of the person being invited (used in welcome prompt)
 * - guardian_name: the name of the guardian who created the invite (used in prompts)
 */
export function migrateVoiceInviteDisplayMetadata(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN friend_name TEXT`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(
      /*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN guardian_name TEXT`,
    );
  } catch {
    /* already exists */
  }
}
