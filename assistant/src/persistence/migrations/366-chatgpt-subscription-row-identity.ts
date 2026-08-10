import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Stamp the ChatGPT-subscription row with its own provider identity.
 *
 * The row is the subscription route by definition (auth modality = provider
 * identity), but it historically stored `provider: "openai"` and was found
 * by name, which left provider "openai" ambiguous on disk: a BYOK api_key
 * row and the subscription row read identically at the provider column.
 * With the row carrying `provider: "chatgpt"`, auth type is derivable from
 * the provider for every row, and provider-keyed scans for "openai" no
 * longer surface the subscription row.
 *
 * Scoped tightly: only the canonical row name with oauth_subscription auth
 * is flipped. A claiming row under the same name with key auth is an
 * ordinary connection and keeps its provider. Idempotent: a flipped row no
 * longer matches, and the table-exists guard covers databases from before
 * migration 243.
 */
export function migrateChatgptSubscriptionRowIdentity(
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

  const row = raw
    .query(
      `SELECT provider, auth FROM provider_connections WHERE name = 'chatgpt-subscription'`,
    )
    .get() as { provider: string; auth: string } | null;
  if (!row || row.provider !== "openai") {
    return;
  }

  let authType: unknown;
  try {
    const parsed: unknown = JSON.parse(row.auth);
    authType =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { type?: unknown }).type
        : undefined;
  } catch {
    return;
  }
  if (authType !== "oauth_subscription") {
    return;
  }

  raw
    .prepare(
      `UPDATE provider_connections SET provider = 'chatgpt', updated_at = ? WHERE name = 'chatgpt-subscription'`,
    )
    .run(Date.now());
}
