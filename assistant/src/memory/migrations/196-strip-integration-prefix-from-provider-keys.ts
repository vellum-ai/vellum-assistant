import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * One-shot migration: strip the `integration:` prefix from provider_key
 * values across all three OAuth tables (oauth_providers, oauth_apps,
 * oauth_connections).
 *
 * Historically provider keys were stored as `integration:google`,
 * `integration:slack`, etc.  The codebase is moving to bare-name keys
 * (`google`, `slack`) for simplicity.  Providers that were already stored
 * with bare names (e.g. `slack_channel`, `telegram`) are unaffected.
 *
 * If a bare-name key already exists (runtime seed data created it), the
 * old `integration:` rows are orphaned — we delete them instead of
 * renaming to avoid UNIQUE constraint violations.
 *
 * FK constraints require us to update child tables (oauth_apps,
 * oauth_connections) before the parent (oauth_providers), or disable FKs.
 * We disable FKs for safety and update all three tables atomically.
 */
export function migrateStripIntegrationPrefixFromProviderKeys(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_strip_integration_prefix_from_provider_keys_v1",
    () => {
      const raw = getSqliteFrom(database);

      raw.exec("PRAGMA foreign_keys = OFF");
      try {
        // Find all provider keys with the integration: prefix.
        const rows = raw
          .prepare(
            /*sql*/ `SELECT provider_key FROM oauth_providers WHERE provider_key LIKE 'integration:%'`,
          )
          .all() as Array<{ provider_key: string }>;

        for (const { provider_key: oldKey } of rows) {
          const newKey = oldKey.replace(/^integration:/, "");

          // Check if the bare-name key already exists (seed data may have created it).
          const bareExists = raw
            .prepare(
              /*sql*/ `SELECT 1 FROM oauth_providers WHERE provider_key = ?`,
            )
            .get(newKey);

          if (bareExists) {
            // Bare-name provider already exists — delete the old prefixed rows
            // to avoid UNIQUE constraint violations.
            raw
              .prepare(
                /*sql*/ `DELETE FROM oauth_connections WHERE provider_key = ?`,
              )
              .run(oldKey);
            raw
              .prepare(/*sql*/ `DELETE FROM oauth_apps WHERE provider_key = ?`)
              .run(oldKey);
            raw
              .prepare(
                /*sql*/ `DELETE FROM oauth_providers WHERE provider_key = ?`,
              )
              .run(oldKey);
          } else {
            // Rename: update child tables first, then parent.
            raw
              .prepare(
                /*sql*/ `UPDATE oauth_connections SET provider_key = ? WHERE provider_key = ?`,
              )
              .run(newKey, oldKey);
            raw
              .prepare(
                /*sql*/ `UPDATE oauth_apps SET provider_key = ? WHERE provider_key = ?`,
              )
              .run(newKey, oldKey);
            raw
              .prepare(
                /*sql*/ `UPDATE oauth_providers SET provider_key = ? WHERE provider_key = ?`,
              )
              .run(newKey, oldKey);
          }
        }

        // Also update the watchers table — credential_service stores provider
        // keys like "integration:google" that feed into resolveOAuthConnection().
        raw
          .prepare(
            /*sql*/ `UPDATE watchers SET credential_service = REPLACE(credential_service, 'integration:', '') WHERE credential_service LIKE 'integration:%'`,
          )
          .run();
      } finally {
        raw.exec("PRAGMA foreign_keys = ON");
      }
    },
  );
}

/**
 * Reverse: re-add the `integration:` prefix to provider keys that don't
 * already have one and aren't known bare-name providers.
 *
 * This is a best-effort rollback — we prefix all keys that look like they
 * were originally `integration:` prefixed.  Known bare-name keys
 * (`slack_channel`, `telegram`) are left as-is because they never had the
 * prefix.
 */
export function migrateStripIntegrationPrefixFromProviderKeysDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Keys that were always bare — never had an integration: prefix.
  const ALWAYS_BARE = new Set(["slack_channel", "telegram"]);

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    const rows = raw
      .prepare(
        /*sql*/ `SELECT provider_key FROM oauth_providers WHERE provider_key NOT LIKE 'integration:%'`,
      )
      .all() as Array<{ provider_key: string }>;

    for (const { provider_key: bareKey } of rows) {
      if (ALWAYS_BARE.has(bareKey)) continue;

      const prefixedKey = `integration:${bareKey}`;

      // If the prefixed key already exists, delete the bare rows.
      const prefixedExists = raw
        .prepare(/*sql*/ `SELECT 1 FROM oauth_providers WHERE provider_key = ?`)
        .get(prefixedKey);

      if (prefixedExists) {
        raw
          .prepare(
            /*sql*/ `DELETE FROM oauth_connections WHERE provider_key = ?`,
          )
          .run(bareKey);
        raw
          .prepare(/*sql*/ `DELETE FROM oauth_apps WHERE provider_key = ?`)
          .run(bareKey);
        raw
          .prepare(/*sql*/ `DELETE FROM oauth_providers WHERE provider_key = ?`)
          .run(bareKey);
      } else {
        raw
          .prepare(
            /*sql*/ `UPDATE oauth_connections SET provider_key = ? WHERE provider_key = ?`,
          )
          .run(prefixedKey, bareKey);
        raw
          .prepare(
            /*sql*/ `UPDATE oauth_apps SET provider_key = ? WHERE provider_key = ?`,
          )
          .run(prefixedKey, bareKey);
        raw
          .prepare(
            /*sql*/ `UPDATE oauth_providers SET provider_key = ? WHERE provider_key = ?`,
          )
          .run(prefixedKey, bareKey);
      }
    }

    // Reverse the watchers table update — re-add the prefix for keys that
    // aren't known bare-name providers.
    const watcherRows = raw
      .prepare(
        /*sql*/ `SELECT DISTINCT credential_service FROM watchers WHERE credential_service NOT LIKE 'integration:%'`,
      )
      .all() as Array<{ credential_service: string }>;

    for (const { credential_service: bareKey } of watcherRows) {
      if (ALWAYS_BARE.has(bareKey)) continue;
      raw
        .prepare(
          /*sql*/ `UPDATE watchers SET credential_service = ? WHERE credential_service = ?`,
        )
        .run(`integration:${bareKey}`, bareKey);
    }
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}
