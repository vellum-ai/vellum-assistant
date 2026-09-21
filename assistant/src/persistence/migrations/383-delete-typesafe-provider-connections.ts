import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

const TYPESAFE_PROVIDER = "typesafe";

/**
 * Remove `provider_connections` rows for the TypeSafe provider.
 *
 * TypeSafe moved from the LLM catalog to the classification family, which
 * reads its credential straight from the credential store (the stored
 * `typesafe` API key survives untouched) and never dispatches through a
 * connection row. A leftover row would name a provider the connection
 * routes no longer recognize. Workspace migration 158 removes the profiles
 * that pointed at these rows.
 *
 * Idempotent: a second run finds no matching rows. The table-exists guard
 * covers databases from before migration 243.
 */
export function migrateDeleteTypesafeProviderConnections(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
    )
    .get();
  if (!tableExists) {
    return;
  }

  raw
    .prepare(`DELETE FROM provider_connections WHERE provider = ?`)
    .run(TYPESAFE_PROVIDER);
}
