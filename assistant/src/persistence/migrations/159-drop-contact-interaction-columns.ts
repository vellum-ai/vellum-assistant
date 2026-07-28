import type { DrizzleDb } from "../db-connection.js";

export function migrateDropContactInteractionColumns(
  database: DrizzleDb,
): void {
  try {
    database.run(/*sql*/ `ALTER TABLE contacts DROP COLUMN interaction_count`);
  } catch {
    /* already dropped or doesn't exist */
  }

  // Drop the index on last_interaction before dropping the column — SQLite
  // rejects ALTER TABLE DROP COLUMN when a dependent index exists.
  database.run(/*sql*/ `DROP INDEX IF EXISTS idx_contacts_last_interaction`);

  try {
    database.run(/*sql*/ `ALTER TABLE contacts DROP COLUMN last_interaction`);
  } catch {
    /* already dropped or doesn't exist */
  }
}
