import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Rewrite `provider_connections.auth` to payload-only JSON: `{"credential":
 * ...}` for keyed auth, `{}` otherwise. The auth type is derived from the
 * provider column on read (vellum is the platform route, chatgpt the
 * subscription route, keyless providers run keyless unless a credential is
 * stored, everything else keys), so a stored `type` key is inert and only
 * the credential payload needs to persist.
 *
 * Rows whose auth column is not parseable JSON are left alone (the DB
 * loaders already treat them as invalid). Idempotent: a stripped row has no
 * `type` key and no longer matches, and the table-exists guard covers
 * databases from before migration 243.
 */
export function migrateStripStoredAuthType(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const tableExists = raw
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
    )
    .get();
  if (!tableExists) {
    return;
  }

  const rows = raw
    .query(`SELECT name, auth FROM provider_connections`)
    .all() as Array<{ name: string; auth: string }>;

  const now = Date.now();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.auth);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) {
      continue;
    }
    const credential = (parsed as { credential?: unknown }).credential;
    const stripped =
      typeof credential === "string" && credential.length > 0
        ? { credential }
        : {};
    raw
      .prepare(
        `UPDATE provider_connections SET auth = ?, updated_at = ? WHERE name = ?`,
      )
      .run(JSON.stringify(stripped), now, row.name);
  }
}
