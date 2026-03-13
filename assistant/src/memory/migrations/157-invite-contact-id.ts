import type { DrizzleDb } from "../db-connection.js";

/**
 * Add a required contact_id column to assistant_ingress_invites.
 * Invites must be bound to the contact they were created for.
 * Legacy rows without a contact_id are deleted since they cannot
 * be redeemed correctly.
 */
export function migrateInviteContactId(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN contact_id TEXT NOT NULL REFERENCES contacts(id) DEFAULT ''`,
    );
  } catch {
    /* already exists */
  }
  // Delete legacy rows that have no contact binding (empty string from DEFAULT).
  database.run(
    /*sql*/ `DELETE FROM assistant_ingress_invites WHERE contact_id = ''`,
  );
}
