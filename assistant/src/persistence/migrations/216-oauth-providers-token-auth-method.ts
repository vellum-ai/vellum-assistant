import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Backfill `oauth_providers.token_endpoint_auth_method` for any rows where
 * the value is NULL or empty string, setting them to the new default
 * "client_secret_post". This brings existing rows in line with the
 * Drizzle schema's new `.notNull().default("client_secret_post")`
 * constraint, which is enforced at write time via the TypeScript layer.
 *
 * SQLite cannot retroactively add a NOT NULL constraint to an existing
 * column without a full table rebuild, so the underlying column remains
 * nullable at the SQLite level. All writes go through Drizzle, which
 * applies the default for any insert that omits the field.
 *
 * The UPDATE is inherently idempotent and safe to re-run. Errors are
 * allowed to propagate to the migration runner in `db-init.ts`, which
 * records the failure, logs it, and continues to the next migration.
 */
export function migrateOAuthProvidersTokenAuthMethodDefault(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  raw.exec(
    `UPDATE oauth_providers
     SET token_endpoint_auth_method = 'client_secret_post'
     WHERE token_endpoint_auth_method IS NULL
        OR token_endpoint_auth_method = ''`,
  );
}
