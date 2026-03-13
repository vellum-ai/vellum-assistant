import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add a required contact_id column to assistant_ingress_invites.
 * Invites must be bound to the contact they were created for.
 * Legacy rows without a contact_id are deleted since they cannot
 * be redeemed correctly.
 */
export function migrateInviteContactId(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  const cols = (
    raw.query(`PRAGMA table_info(assistant_ingress_invites)`).all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);

  if (!cols.includes("contact_id")) {
    // Add without REFERENCES — the Drizzle schema does not declare a FK here,
    // and the FK constraint caused ALTER TABLE to fail on databases with
    // PRAGMA foreign_keys = ON (no contact with id = '' exists).
    database.run(
      /*sql*/ `ALTER TABLE assistant_ingress_invites ADD COLUMN contact_id TEXT NOT NULL DEFAULT ''`,
    );
  }

  // Delete legacy rows that have no contact binding (empty string from DEFAULT).
  database.run(
    /*sql*/ `DELETE FROM assistant_ingress_invites WHERE contact_id = ''`,
  );
}
