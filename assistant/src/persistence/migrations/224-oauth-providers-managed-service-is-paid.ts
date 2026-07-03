import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

/**
 * Add the `managed_service_is_paid` column to `oauth_providers`.
 *
 * Flags whether a provider's managed OAuth variant requires a paid plan
 * upstream (e.g. Twitter). Defaults to 0 (false) for all existing rows.
 *
 * Mirrors the pattern from migration 178. The raw.exec() call below is
 * Drizzle's SQLite statement runner — NOT a shell exec.
 */
export function migrateOAuthProvidersManagedServiceIsPaid(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      /*sql*/ `ALTER TABLE oauth_providers ADD COLUMN managed_service_is_paid INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
