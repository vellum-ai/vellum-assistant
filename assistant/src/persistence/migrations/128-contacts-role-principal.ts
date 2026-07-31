import type { DrizzleDb } from "../db-connection.js";

/**
 * Add role and principal_id columns to the contacts table.
 *
 * - role: discriminates guardian vs regular contact (defaults to 'contact'
 *   so existing rows are unaffected).
 * - principal_id: nullable internal auth principal ID, linking the contact
 *   to a guardian principal when applicable.
 *
 * Uses ALTER TABLE ADD COLUMN with try/catch for idempotency.
 */
export function migrateContactsRolePrincipal(database: DrizzleDb): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE contacts ADD COLUMN role TEXT NOT NULL DEFAULT 'contact'`,
    );
  } catch {
    /* already exists */
  }
  try {
    database.run(/*sql*/ `ALTER TABLE contacts ADD COLUMN principal_id TEXT`);
  } catch {
    /* already exists */
  }
}
