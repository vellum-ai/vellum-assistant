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
 */
export function migrateOAuthProvidersTokenAuthMethodDefault(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      `UPDATE oauth_providers
       SET token_endpoint_auth_method = 'client_secret_post'
       WHERE token_endpoint_auth_method IS NULL
          OR token_endpoint_auth_method = ''`,
    );
  } catch {
    // Backfill failed — log via the migration runner's outer catch.
    // No state to roll back: the UPDATE is idempotent and partial
    // updates are tolerable (they will be retried on next startup).
  }
}
