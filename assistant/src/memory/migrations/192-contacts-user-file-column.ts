import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

export function migrateContactsUserFileColumn(database: DrizzleDb): void {
  withCrashRecovery(database, "migration_contacts_user_file_column_v1", () => {
    const raw = getSqliteFrom(database);

    try {
      raw.exec(/*sql*/ `ALTER TABLE contacts ADD COLUMN user_file TEXT`);
    } catch {
      /* already exists */
    }
  });
}
