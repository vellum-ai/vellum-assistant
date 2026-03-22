import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
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
        // If `integration:google` already exists (runtime seeded it after the
        // code rename), the old `integration:gmail` rows are orphaned — just
        // delete them instead of renaming.
        const googleExists = raw
          .prepare(
            /*sql*/ `SELECT 1 FROM oauth_providers WHERE provider_key = 'integration:google'`,
          )
          .get();

        if (googleExists) {
          raw.exec(
            /*sql*/ `DELETE FROM oauth_connections WHERE provider_key = 'integration:gmail'`,
          );
          raw.exec(
            /*sql*/ `DELETE FROM oauth_apps WHERE provider_key = 'integration:gmail'`,
          );
          raw.exec(
            /*sql*/ `DELETE FROM oauth_providers WHERE provider_key = 'integration:gmail'`,
          );
        } else {
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
        }
      } finally {
        raw.exec("PRAGMA foreign_keys = ON");
      }
    },
  );
}

/**
 * Reverse: rename "integration:google" back to "integration:gmail" across
 * OAuth tables.
 *
 * Mirrors the forward migration logic but in the opposite direction. If
 * `integration:gmail` already exists (shouldn't normally happen on rollback),
 * deletes the google rows to avoid duplicates.
 */
export function migrateRenameGmailProviderKeyToGoogleDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    const gmailExists = raw
      .prepare(
        /*sql*/ `SELECT 1 FROM oauth_providers WHERE provider_key = 'integration:gmail'`,
      )
      .get();

    if (gmailExists) {
      // Old gmail rows already exist — delete the google ones to avoid duplication.
      raw.exec(
        /*sql*/ `DELETE FROM oauth_connections WHERE provider_key = 'integration:google'`,
      );
      raw.exec(
        /*sql*/ `DELETE FROM oauth_apps WHERE provider_key = 'integration:google'`,
      );
      raw.exec(
        /*sql*/ `DELETE FROM oauth_providers WHERE provider_key = 'integration:google'`,
      );
    } else {
      // Rename google back to gmail — children first, then parent.
      raw.exec(
        /*sql*/ `UPDATE oauth_connections SET provider_key = 'integration:gmail' WHERE provider_key = 'integration:google'`,
      );
      raw.exec(
        /*sql*/ `UPDATE oauth_apps SET provider_key = 'integration:gmail' WHERE provider_key = 'integration:google'`,
      );
      raw.exec(
        /*sql*/ `UPDATE oauth_providers SET provider_key = 'integration:gmail' WHERE provider_key = 'integration:google'`,
      );
    }
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}
