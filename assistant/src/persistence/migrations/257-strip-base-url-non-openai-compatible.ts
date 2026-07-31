import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Strip `base_url` from provider connections whose provider is NOT
 * `openai-compatible`. These values should never have been accepted — the
 * route layer now rejects them, but existing rows may still carry one from
 * before the validation was added. Setting it to NULL prevents
 * API-key exfiltration via a redirected base URL.
 *
 * Idempotent — re-running is a no-op once all non-openai-compatible rows
 * already have NULL base_url.
 */
export function migrateStripBaseUrlNonOpenaiCompatible(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Only clear base_url on rows where provider is NOT openai-compatible.
  raw.exec(
    `UPDATE provider_connections SET base_url = NULL WHERE provider != 'openai-compatible' AND base_url IS NOT NULL`,
  );
}
