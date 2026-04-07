/**
 * OAuth2 token persistence helper.
 *
 * Extracted from vault.ts so it can be reused by both the credential
 * vault tool (interactive and deferred paths) and the OAuth
 * orchestrator without duplicating storage logic.
 *
 * Writes exclusively to the SQLite tables (oauth_app, oauth_connection)
 * and new-format secure keys (`oauth_app/{id}/...`,
 * `oauth_connection/{id}/...`).
 *
 * Token storage key paths and secure-key persistence are delegated to
 * the shared `@vellumai/credential-storage` package.
 */

import {
  oauthAppClientSecretPath,
  persistOAuthTokens,
  type SecureKeyBackend,
} from "@vellumai/credential-storage";

import type { OAuth2FlowResult } from "../security/oauth2.js";
import {
  deleteSecureKeyAsync,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { runPostConnectHook } from "../tools/credentials/post-connect-hooks.js";
import {
  createConnection,
  getActiveConnection,
  getApp,
  listActiveConnectionsByProvider,
  updateConnection,
  upsertApp,
} from "./oauth-store.js";

// ---------------------------------------------------------------------------
// Secure-key backend adapter
// ---------------------------------------------------------------------------

const secureKeyBackend: SecureKeyBackend = {
  get: (key: string) => getSecureKeyAsync(key),
  set: (key: string, value: string) => setSecureKeyAsync(key, value),
  delete: async (key: string) => deleteSecureKeyAsync(key),
  list: async () => [],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoreOAuth2TokensParams {
  service: string;
  tokens: OAuth2FlowResult["tokens"];
  grantedScopes: string[];
  rawTokenResponse: Record<string, unknown>;
  clientId: string;
  clientSecret?: string;
  userinfoUrl?: string;
  /**
   * Best-effort account identifier parsed from the provider's identity
   * endpoint (e.g. email, @username, display name). The format varies by
   * provider and may be undefined if the API call fails.
   */
  parsedAccountIdentifier?: string;
  /** Pre-resolved oauth_app ID — skips the upsertApp() call if provided. */
  oauthAppId?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Store OAuth2 tokens and associated metadata after a successful flow.
 *
 * Persists the access token, optional refresh token, client credentials,
 * and metadata (scopes, expiry, account info) into the SQLite oauth_app /
 * oauth_connection tables with new-format secure keys. Runs any registered
 * post-connect hook for the service.
 */
export async function storeOAuth2Tokens(
  params: StoreOAuth2TokensParams,
): Promise<{ accountInfo?: string }> {
  const {
    service,
    tokens,
    grantedScopes,
    rawTokenResponse,
    clientId,
    clientSecret,
    userinfoUrl,
  } = params;

  const expiresAt = tokens.expiresIn
    ? Date.now() + tokens.expiresIn * 1000
    : null;

  // Account identifier parsing is best-effort. The format varies by provider
  // (email for Google, username for GitHub, display name for Spotify, etc.)
  // and may be undefined if the userinfo/identity API call fails or the
  // required scope wasn't granted.
  let accountInfo: string | undefined;
  if (userinfoUrl && grantedScopes.some((s) => s.includes("userinfo"))) {
    try {
      const resp = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (resp.ok) {
        const info = (await resp.json()) as { email?: string };
        accountInfo = info.email;
      }
    } catch {
      // Non-fatal
    }
  }

  const resolvedAccountInfo = accountInfo ?? params.parsedAccountIdentifier;

  // -------------------------------------------------------------------
  // SQLite oauth_app + oauth_connection + new-format secure keys
  // -------------------------------------------------------------------

  // 1. Upsert the oauth_app row (or use the pre-resolved ID).
  const app = params.oauthAppId
    ? (getApp(params.oauthAppId) ?? {
        id: params.oauthAppId,
        clientSecretCredentialPath: oauthAppClientSecretPath(params.oauthAppId),
      })
    : await upsertApp(
        service,
        clientId,
        clientSecret ? { clientSecretValue: clientSecret } : undefined,
      );

  // When oauthAppId is pre-resolved, still persist clientSecret if provided.
  if (params.oauthAppId && clientSecret) {
    const stored = await setSecureKeyAsync(
      app.clientSecretCredentialPath,
      clientSecret,
    );
    if (!stored) {
      throw new Error("Failed to store client_secret in secure storage");
    }
  }

  // 2. Upsert oauth_connection — reuse existing active connection for the
  //    same account, or create a new one for a different account.
  //    First try to match by account info (email); fall back to provider-only
  //    lookup so that re-auth without userinfo still updates the right row.
  //    However, treat provider-only matches as ambiguous when multiple active
  //    connections exist to avoid overwriting the wrong account's tokens.
  let existingConn: ReturnType<typeof getActiveConnection>;
  if (resolvedAccountInfo) {
    existingConn = getActiveConnection(service, {
      account: resolvedAccountInfo,
    });
  } else {
    const activeConns = listActiveConnectionsByProvider(service);
    // Only reuse the provider-only match when it's unambiguous (single connection).
    existingConn = activeConns.length === 1 ? activeConns[0] : undefined;
  }
  let connId: string;

  const hasRefreshToken = !!tokens.refreshToken;

  // Only reuse the existing connection if it's the same account (or we can't
  // tell). When the user connects a different account for the same service,
  // create a separate connection so we don't overwrite the first account's
  // tokens.
  const isNewAccount =
    existingConn &&
    resolvedAccountInfo !== undefined &&
    existingConn.accountInfo !== undefined &&
    resolvedAccountInfo !== existingConn.accountInfo;

  if (existingConn && !isNewAccount) {
    connId = existingConn.id;
    updateConnection(connId, {
      oauthAppId: app.id,
      accountInfo: resolvedAccountInfo,
      grantedScopes,
      expiresAt,
      hasRefreshToken,
      metadata: rawTokenResponse,
    });
  } else {
    const conn = createConnection({
      oauthAppId: app.id,
      provider: service,
      accountInfo: resolvedAccountInfo,
      grantedScopes,
      expiresAt: expiresAt ?? undefined,
      hasRefreshToken,
      metadata: rawTokenResponse,
    });
    connId = conn.id;
  }

  // 3-4. Persist access + refresh tokens via shared helper
  await persistOAuthTokens(secureKeyBackend, connId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  });

  // Run any provider-specific post-connect actions (e.g. Slack welcome DM)
  await runPostConnectHook({ service, rawTokenResponse });

  return { accountInfo: resolvedAccountInfo };
}
