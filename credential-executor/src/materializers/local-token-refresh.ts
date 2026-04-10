/**
 * OAuth token refresh implementation for CES local mode.
 *
 * Performs the actual OAuth2 token refresh by:
 * 1. Looking up the connection's provider and app configuration from the
 *    assistant's SQLite database (read-only).
 * 2. Retrieving the client secret from the secure-key backend.
 * 3. Calling the provider's token endpoint with the refresh token.
 * 4. Returning a `TokenRefreshResult` for the `LocalMaterialiser` to persist.
 *
 * This module does NOT import any assistant-internal modules. It queries
 * the SQLite database directly (like `local-oauth-lookup.ts`) and performs
 * the HTTP refresh call inline (replicating the logic from the assistant's
 * `security/oauth2.ts:refreshOAuth2Token`).
 */

import Database from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  computeExpiresAt,
  type SecureKeyBackend,
  type TokenRefreshResult,
} from "@vellumai/credential-storage";

import type { TokenRefreshFn } from "./local.js";

// ---------------------------------------------------------------------------
// SQLite row shapes (match assistant schema without importing Drizzle)
// ---------------------------------------------------------------------------

interface OAuthConnectionRow {
  id: string;
  oauth_app_id: string;
  provider_key: string;
}

interface OAuthAppRow {
  id: string;
  provider_key: string;
  client_id: string;
  client_secret_credential_path: string;
}

interface OAuthProviderRow {
  provider_key: string;
  token_url: string;
  refresh_url: string | null;
  token_endpoint_auth_method: string | null;
  token_exchange_body_format: string | null;
}

// ---------------------------------------------------------------------------
// Token endpoint auth method (matches assistant/src/security/oauth2.ts)
// ---------------------------------------------------------------------------

type TokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post";

// ---------------------------------------------------------------------------
// Refresh config resolution
// ---------------------------------------------------------------------------

interface RefreshConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  authMethod: TokenEndpointAuthMethod;
  bodyFormat: "form" | "json";
}

/**
 * Resolve the OAuth refresh configuration for a connection by querying
 * the assistant's SQLite database (read-only) and the secure-key backend.
 */
async function resolveRefreshConfig(
  dbPath: string,
  connectionId: string,
  secureKeyBackend: SecureKeyBackend,
): Promise<RefreshConfig | { error: string }> {
  if (!existsSync(dbPath)) {
    return { error: `Database not found at ${dbPath}` };
  }

  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });

    // 1. Look up the connection to get oauth_app_id and provider_key
    const conn = db
      .query<OAuthConnectionRow, [string, string]>(
        `SELECT id, oauth_app_id, provider_key FROM oauth_connections WHERE id = ? AND status = ? LIMIT 1`,
      )
      .get(connectionId, "active");

    if (!conn) {
      return { error: `No active OAuth connection found for "${connectionId}"` };
    }

    // 2. Look up the app to get client_id and client_secret_credential_path
    const app = db
      .query<OAuthAppRow, [string]>(
        `SELECT id, provider_key, client_id, client_secret_credential_path FROM oauth_apps WHERE id = ? LIMIT 1`,
      )
      .get(conn.oauth_app_id);

    if (!app) {
      return { error: `No OAuth app found for connection "${connectionId}"` };
    }

    // 3. Look up the provider to get token_url and auth method
    const provider = db
      .query<OAuthProviderRow, [string]>(
        `SELECT provider_key, token_url, refresh_url, token_endpoint_auth_method, token_exchange_body_format FROM oauth_providers WHERE provider_key = ? LIMIT 1`,
      )
      .get(conn.provider_key);

    if (!provider) {
      return { error: `No OAuth provider found for "${conn.provider_key}"` };
    }

    // Resolve the effective token URL: prefer refresh_url, fall back to token_url
    const tokenUrl = provider.refresh_url || provider.token_url;

    if (!tokenUrl || !app.client_id) {
      return { error: `Missing OAuth2 refresh config for "${conn.provider_key}"` };
    }

    // 4. Retrieve the client secret from secure storage
    const clientSecret = await secureKeyBackend.get(
      app.client_secret_credential_path,
    );

    const authMethod = (provider.token_endpoint_auth_method as TokenEndpointAuthMethod | null) ?? "client_secret_post";
    const bodyFormat = (provider.token_exchange_body_format as "form" | "json" | null) ?? "form";

    return {
      tokenUrl,
      clientId: app.client_id,
      clientSecret,
      authMethod,
      bodyFormat,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Failed to resolve refresh config: ${msg}` };
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP token refresh (replicates assistant/src/security/oauth2.ts logic)
// ---------------------------------------------------------------------------

interface RefreshTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

async function performTokenRefresh(
  config: RefreshConfig,
  refreshToken: string,
): Promise<RefreshTokenResponse> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };

  const headers: Record<string, string> = {
    "Content-Type":
      config.bodyFormat === "json"
        ? "application/json"
        : "application/x-www-form-urlencoded",
  };

  if (config.clientSecret && config.authMethod === "client_secret_basic") {
    const credentials = Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  } else {
    body.client_id = config.clientId;
    if (config.clientSecret) {
      body.client_secret = config.clientSecret;
    }
  }

  const resp = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body:
      config.bodyFormat === "json"
        ? JSON.stringify(body)
        : new URLSearchParams(body),
  });

  if (!resp.ok) {
    const rawBody = await resp.text().catch(() => "");
    let errorCode = "";
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.error) {
        errorCode = String(parsed.error);
      }
    } catch {
      // non-JSON response
    }
    const detail = errorCode
      ? `HTTP ${resp.status}: ${errorCode}`
      : `HTTP ${resp.status}`;
    throw new Error(`OAuth2 token refresh failed (${detail})`);
  }

  const data = (await resp.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
    expiresIn: data.expires_in as number | undefined,
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a `TokenRefreshFn` for CES local mode.
 *
 * The returned function looks up OAuth configuration from the assistant's
 * SQLite database (read-only) and performs the HTTP token refresh call.
 * Token persistence is handled by the `LocalMaterialiser` after this
 * function returns.
 *
 * @param vellumRoot - The Vellum root directory (e.g. `~/.vellum`).
 * @param secureKeyBackend - Backend for retrieving the OAuth client secret.
 */
export function createLocalTokenRefreshFn(
  vellumRoot: string,
  secureKeyBackend: SecureKeyBackend,
): TokenRefreshFn {
  const dbPath = join(vellumRoot, "workspace", "data", "db", "assistant.db");

  return async (
    connectionId: string,
    refreshToken: string,
  ): Promise<TokenRefreshResult> => {
    // 1. Resolve the refresh config from SQLite + secure storage
    const config = await resolveRefreshConfig(
      dbPath,
      connectionId,
      secureKeyBackend,
    );

    if ("error" in config) {
      return { success: false, error: config.error };
    }

    // 2. Perform the HTTP token refresh
    try {
      const result = await performTokenRefresh(config, refreshToken);
      const expiresAt = computeExpiresAt(result.expiresIn ?? null);

      return {
        success: true,
        accessToken: result.accessToken,
        expiresAt,
        refreshToken: result.refreshToken,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  };
}
