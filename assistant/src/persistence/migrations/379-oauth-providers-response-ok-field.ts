import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add `response_ok_field` to `oauth_providers`: the dot path of the boolean a
 * provider's API puts in every response body to report success (Slack: `ok`).
 * It is its own column, distinct from `identity_ok_field`, because the two
 * declare different facts: the identity field governs one call the provider
 * row names, while this one governs any request made with the credential.
 *
 * Idempotent: the ALTER is skipped when the column already exists.
 */
export function migrateOAuthProvidersResponseOkField(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec("ALTER TABLE oauth_providers ADD COLUMN response_ok_field TEXT");
  } catch {
    // Column already exists.
  }
}
