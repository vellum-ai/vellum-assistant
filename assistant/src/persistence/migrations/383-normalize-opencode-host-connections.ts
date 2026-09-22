import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Restamp openai-compatible rows whose endpoint host is opencode.ai (or a
 * subdomain) as provider "opencode". The generic adapter never sends the
 * session headers zen/go requires, so such rows fail every request; the
 * create route applies the same normalization on write. Hosts are judged
 * by URL parsing, not pattern matching, so a path that merely mentions
 * opencode.ai is left alone. Idempotent: a restamped row no longer matches.
 * Workspace migration 158 repoints legacy-shape profile fragments bound to
 * these rows.
 */
export function migrateNormalizeOpencodeHostConnections(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  const rows = raw
    .query(
      `SELECT name, base_url FROM provider_connections
        WHERE provider = 'openai-compatible' AND base_url IS NOT NULL`,
    )
    .all() as Array<{ name: string; base_url: string }>;

  const restamp = raw.prepare(
    `UPDATE provider_connections SET provider = 'opencode', updated_at = ? WHERE name = ?`,
  );
  const now = Date.now();
  for (const row of rows) {
    if (isOpenCodeHost(row.base_url)) {
      restamp.run(now, row.name);
    }
  }
}

function isOpenCodeHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}
