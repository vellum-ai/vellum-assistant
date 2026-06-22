import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateContactsUserFileColumn(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  try {
    raw.exec(/*sql*/ `ALTER TABLE contacts ADD COLUMN user_file TEXT`);
  } catch {
    /* already exists */
  }
}
