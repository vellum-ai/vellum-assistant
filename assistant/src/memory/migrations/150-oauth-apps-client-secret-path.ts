import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Add client_secret_credential_path column to oauth_apps.
 *
 * Makes explicit what was previously implicit: the credential path pattern
 * `oauth_app/${id}/client_secret`. Steps:
 *
 * 1. ALTER TABLE to add the column (nullable initially).
 * 2. Backfill existing rows with `oauth_app/${id}/client_secret`.
 * 3. Rebuild the table to enforce NOT NULL (SQLite doesn't support ALTER COLUMN).
 *
 * Idempotent — skips if the column already exists with NOT NULL.
 */
export function migrateOAuthAppsClientSecretPath(database: DrizzleDb): void {
  withCrashRecovery(
    database,
    "migration_oauth_apps_client_secret_path_v1",
    () => {
      const raw = getSqliteFrom(database);

      // Guard: table must exist
      const tableExists = raw
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_apps'`,
        )
        .get();
      if (!tableExists) return;

      // Guard: check if column already exists with NOT NULL
      const colInfo = raw
        .query(
          `SELECT "notnull" FROM pragma_table_info('oauth_apps') WHERE name = 'client_secret_credential_path'`,
        )
        .get() as { notnull: number } | null;
      if (colInfo && colInfo.notnull === 1) return;

      // Step 1: Add the column (nullable) — wrapped in try/catch for idempotency
      if (!colInfo) {
        try {
          raw.exec(
            /*sql*/ `ALTER TABLE oauth_apps ADD COLUMN client_secret_credential_path TEXT`,
          );
        } catch {
          // Column may already exist from a previous partial run
        }
      }

      // Step 2: Backfill existing rows
      raw.exec(
        /*sql*/ `UPDATE oauth_apps SET client_secret_credential_path = 'oauth_app/' || id || '/client_secret' WHERE client_secret_credential_path IS NULL`,
      );

      // Step 3: Rebuild the table to enforce NOT NULL
      raw.exec("PRAGMA foreign_keys = OFF");
      try {
        raw.exec("BEGIN");

        raw.exec(/*sql*/ `
          CREATE TABLE oauth_apps_new (
            id TEXT PRIMARY KEY,
            provider_key TEXT NOT NULL REFERENCES oauth_providers(provider_key),
            client_id TEXT NOT NULL,
            client_secret_credential_path TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);

        raw.exec(/*sql*/ `
          INSERT INTO oauth_apps_new
          SELECT id, provider_key, client_id, client_secret_credential_path, created_at, updated_at
          FROM oauth_apps
        `);

        raw.exec(/*sql*/ `DROP TABLE oauth_apps`);
        raw.exec(/*sql*/ `ALTER TABLE oauth_apps_new RENAME TO oauth_apps`);

        // Recreate the unique index
        raw.exec(
          /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_apps_provider_client ON oauth_apps(provider_key, client_id)`,
        );

        raw.exec("COMMIT");
      } catch (e) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* no active transaction */
        }
        throw e;
      } finally {
        raw.exec("PRAGMA foreign_keys = ON");
      }
    },
  );
}

/**
 * Reverse: drop the client_secret_credential_path column from oauth_apps.
 *
 * Rebuilds the table without the column (SQLite doesn't support DROP COLUMN
 * on older versions). Idempotent — skips if the column doesn't exist.
 */
export function migrateOAuthAppsClientSecretPathDown(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Guard: table must exist
  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_apps'`,
    )
    .get();
  if (!tableExists) return;

  // Guard: if the column doesn't exist, nothing to do
  const colInfo = raw
    .query(
      `SELECT 1 FROM pragma_table_info('oauth_apps') WHERE name = 'client_secret_credential_path'`,
    )
    .get();
  if (!colInfo) return;

  raw.exec("PRAGMA foreign_keys = OFF");
  try {
    raw.exec(/*sql*/ `
      CREATE TABLE oauth_apps_rollback (
        id TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL REFERENCES oauth_providers(provider_key),
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    raw.exec(/*sql*/ `
      INSERT INTO oauth_apps_rollback
      SELECT id, provider_key, client_id, created_at, updated_at
      FROM oauth_apps
    `);

    raw.exec(/*sql*/ `DROP TABLE oauth_apps`);
    raw.exec(/*sql*/ `ALTER TABLE oauth_apps_rollback RENAME TO oauth_apps`);

    raw.exec(
      /*sql*/ `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_apps_provider_client ON oauth_apps(provider_key, client_id)`,
    );
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
  }
}
