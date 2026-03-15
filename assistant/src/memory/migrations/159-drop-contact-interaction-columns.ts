import type { DrizzleDb } from "../db-connection.js";

export function migrateDropContactInteractionColumns(
  database: DrizzleDb,
): void {
  try {
    database.run(/*sql*/ `ALTER TABLE contacts DROP COLUMN interaction_count`);
  } catch {
    /* already dropped or doesn't exist */
  }
  try {
    database.run(/*sql*/ `ALTER TABLE contacts DROP COLUMN last_interaction`);
  } catch {
    /* already dropped or doesn't exist */
  }
}
