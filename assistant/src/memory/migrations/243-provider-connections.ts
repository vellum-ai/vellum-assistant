import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Creates the `provider_connections` table and seeds the three canonical
 * connections that every installation ships with.
 *
 * Canonical connections:
 *   - anthropic-managed  → provider=anthropic, auth={type:platform}
 *   - openai-managed     → provider=openai,    auth={type:platform}
 *   - gemini-managed     → provider=gemini,    auth={type:platform}
 *
 * Idempotent: checks sqlite_master for the table before running DDL;
 * canonical rows are inserted with INSERT OR IGNORE.
 */
export function migrateCreateProviderConnections(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
    )
    .get();

  if (!tableExists) {
    try {
      raw.exec("BEGIN");

      raw.exec(/*sql*/ `
        CREATE TABLE provider_connections (
          name        TEXT PRIMARY KEY,
          provider    TEXT NOT NULL,
          auth        TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        )
      `);

      raw.exec(/*sql*/ `
        CREATE INDEX idx_provider_connections_provider
          ON provider_connections(provider)
      `);

      raw.exec("COMMIT");
    } catch (e) {
      try {
        raw.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      throw e;
    }
  }

  // Seed canonical connections — idempotent via INSERT OR IGNORE.
  const now = Date.now();
  const canonicals = [
    { name: "anthropic-managed", provider: "anthropic", auth: JSON.stringify({ type: "platform" }) },
    { name: "openai-managed",    provider: "openai",    auth: JSON.stringify({ type: "platform" }) },
    { name: "gemini-managed",    provider: "gemini",    auth: JSON.stringify({ type: "platform" }) },
  ];

  for (const { name, provider, auth } of canonicals) {
    raw.run(
      `INSERT OR IGNORE INTO provider_connections (name, provider, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [name, provider, auth, now, now],
    );
  }
}
