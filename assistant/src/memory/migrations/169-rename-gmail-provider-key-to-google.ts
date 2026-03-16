import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * One-shot migration: rename the `integration:gmail` provider key to
 * `integration:google` across all three OAuth tables.
 *
 * PR #16355 renamed the provider key in code but did not include a data
 * migration. Without this, existing users who connected Gmail before the
 * rename have their connections orphaned — runtime lookups for
 * `integration:google` never find the old `integration:gmail` rows.
 *
 * FK constraints require us to update child tables (oauth_apps,
 * oauth_connections) before the parent (oauth_providers), or disable FKs.
 * We disable FKs for safety and update all three tables atomically.
 */
export function migrateRenameGmailProviderKeyToGoogle(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_rename_gmail_provider_key_to_google_v1",
    () => {
      const raw = getSqliteFrom(database);

      raw.exec("PRAGMA foreign_keys = OFF");
      try {
        // Update child tables first, then the parent.
        raw.exec(
          /*sql*/ `UPDATE oauth_connections SET provider_key = 'integration:google' WHERE provider_key = 'integration:gmail'`,
        );
        raw.exec(
          /*sql*/ `UPDATE oauth_apps SET provider_key = 'integration:google' WHERE provider_key = 'integration:gmail'`,
        );
        raw.exec(
          /*sql*/ `UPDATE oauth_providers SET provider_key = 'integration:google' WHERE provider_key = 'integration:gmail'`,
        );
      } finally {
        raw.exec("PRAGMA foreign_keys = ON");
      }
    },
  );
}
