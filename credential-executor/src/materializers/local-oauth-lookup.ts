/**
 * CES-native read-only OAuth connection lookup for local mode.
 *
 * In local mode, CES runs as a child process of the assistant on the same
 * machine and can read the assistant's SQLite database to look up OAuth
 * connections.
 *
 * This implementation opens the database in read-only mode and queries the
 * `oauth_connections` table directly using raw SQLite queries. It does not
 * use Drizzle ORM to avoid importing assistant-internal schema modules.
 *
 * The lookup is read-only — CES never modifies OAuth connection records.
 */

import Database from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { OAuthConnectionRecord } from "@vellumai/credential-storage";
import { oauthConnectionAccessTokenPath } from "@vellumai/credential-storage";
import type { OAuthConnectionLookup } from "../subjects/local.js";

// ---------------------------------------------------------------------------
// Raw SQLite row shape (matches oauth_connections table)
// ---------------------------------------------------------------------------

interface OAuthConnectionRow {
  id: string;
  oauth_app_id: string;
  provider_key: string;
  account_info: string | null;
  granted_scopes: string;
  expires_at: number | null;
  has_refresh_token: number;
  status: string;
  label: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Row → OAuthConnectionRecord mapping
// ---------------------------------------------------------------------------

function rowToRecord(row: OAuthConnectionRow): OAuthConnectionRecord {
  return {
    id: row.id,
    providerKey: row.provider_key,
    accountInfo: row.account_info,
    grantedScopes: JSON.parse(row.granted_scopes || "[]"),
    accessTokenPath: oauthConnectionAccessTokenPath(row.id),
    hasRefreshToken: row.has_refresh_token === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Lookup implementation
// ---------------------------------------------------------------------------

/**
 * Create a read-only OAuth connection lookup backed by the assistant's
 * SQLite database.
 *
 * @param vellumRoot - The Vellum root directory (e.g. `~/.vellum`).
 */
export function createLocalOAuthLookup(
  vellumRoot: string,
): OAuthConnectionLookup {
  const dbPath = join(vellumRoot, "workspace", "data", "db", "assistant.db");

  return {
    getById(connectionId: string): OAuthConnectionRecord | undefined {
      if (!existsSync(dbPath)) return undefined;

      let db: Database | undefined;
      try {
        db = new Database(dbPath, { readonly: true });
        const row = db
          .query<OAuthConnectionRow, [string, string]>(
            `SELECT * FROM oauth_connections WHERE id = ? AND status = ? LIMIT 1`,
          )
          .get(connectionId, "active");

        if (!row) return undefined;
        return rowToRecord(row);
      } catch {
        return undefined;
      } finally {
        db?.close();
      }
    },
  };
}
