import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Deletes the per-provider `*-managed` connections that the single
 * provider-agnostic `vellum` connection replaced.
 *
 * The flip (repoint every reference onto `vellum`, stop seeding the
 * per-provider rows, hide the orphans from the connection list) shipped first
 * and is non-destructive. This migration is the contract step: once nothing
 * references the old rows, delete them so the list filter is no longer needed
 * and fresh installs seeded by migration 243 don't carry dead rows.
 *
 * Names are hardcoded on purpose — this migration is a frozen historical
 * snapshot and must not drift with future changes to the canonical list.
 *
 * Idempotent: deleting rows that no longer exist is a no-op.
 */
const LEGACY_MANAGED_CONNECTION_NAMES = [
  "anthropic-managed",
  "openai-managed",
  "gemini-managed",
  "fireworks-managed",
  "together-managed",
];

export function migrateRemoveLegacyManagedConnections(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // The table may not exist yet on a brand-new install if migration ordering
  // ever changes; guard so this is safe to run unconditionally.
  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
    )
    .get();
  if (!tableExists) return;

  const placeholders = LEGACY_MANAGED_CONNECTION_NAMES.map(() => "?").join(
    ", ",
  );
  raw.run(
    `DELETE FROM provider_connections WHERE name IN (${placeholders})`,
    LEGACY_MANAGED_CONNECTION_NAMES,
  );
}
