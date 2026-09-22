import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Restamp openai-compatible rows whose endpoint is opencode.ai as provider
 * "opencode". The generic adapter never sends the session headers zen/go
 * requires, so such rows fail every request; `createConnection` and
 * `updateConnection` apply the same normalization on write. Idempotent:
 * a restamped row no longer matches, and the table-exists guard covers
 * databases from before migration 243.
 */
export function migrateNormalizeOpencodeHostConnections(
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
    .prepare(
      `UPDATE provider_connections
         SET provider = 'opencode', updated_at = ?
       WHERE provider = 'openai-compatible'
         AND (base_url LIKE 'https://opencode.ai/%'
           OR base_url LIKE 'http://opencode.ai/%'
           OR base_url LIKE 'https://%.opencode.ai/%'
           OR base_url LIKE 'http://%.opencode.ai/%')`,
    )
    .run(Date.now());
}
