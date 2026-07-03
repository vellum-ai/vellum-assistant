import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";

export function migrateOAuthProvidersTokenExchangeBodyFormat(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);
  try {
    raw.exec(
      /*sql*/ `ALTER TABLE oauth_providers ADD COLUMN token_exchange_body_format TEXT NOT NULL DEFAULT 'form'`,
    );
  } catch {
    // Column already exists — nothing to do.
  }
}
