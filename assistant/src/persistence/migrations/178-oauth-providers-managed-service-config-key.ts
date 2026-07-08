import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersManagedServiceConfigKey(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      /*sql*/ `ALTER TABLE oauth_providers ADD COLUMN managed_service_config_key TEXT`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
