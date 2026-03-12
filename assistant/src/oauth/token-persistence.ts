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
 */

import type {
  OAuth2FlowResult,
  TokenEndpointAuthMethod,
} from "../security/oauth2.js";
import {
  deleteSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import { runPostConnectHook } from "../tools/credentials/post-connect-hooks.js";
import {
  createConnection,
  getConnectionByProvider,
  updateConnection,
  upsertApp,
} from "./oauth-store.js";

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
  tokenUrl: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  userinfoUrl?: string;
  allowedTools?: string[];
  wellKnownInjectionTemplates?: CredentialInjectionTemplate[];
  /** Fallback account info from an identity verifier (e.g. @username, email). */
  identityAccountInfo?: string;
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

  const resolvedAccountInfo = accountInfo ?? params.identityAccountInfo;

  // -------------------------------------------------------------------
  // SQLite oauth_app + oauth_connection + new-format secure keys
  // -------------------------------------------------------------------

  // 1. Upsert the oauth_app row (or use the pre-resolved ID).
  const app = params.oauthAppId
    ? { id: params.oauthAppId }
    : await upsertApp(service, clientId, clientSecret);

  // When oauthAppId is pre-resolved, still persist clientSecret if provided.
  if (params.oauthAppId && clientSecret) {
    const stored = await setSecureKeyAsync(
      `oauth_app/${params.oauthAppId}/client_secret`,
      clientSecret,
    );
    if (!stored) {
      throw new Error("Failed to store client_secret in secure storage");
    }
  }

  // 2. Upsert oauth_connection — reuse existing active connection for this
  //    provider, or create a new one.
  const existingConn = getConnectionByProvider(service);
  let connId: string;

  const hasRefreshToken = !!tokens.refreshToken;

  if (existingConn) {
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
      providerKey: service,
      accountInfo: resolvedAccountInfo,
      grantedScopes,
      expiresAt: expiresAt ?? undefined,
      hasRefreshToken,
      metadata: rawTokenResponse,
    });
    connId = conn.id;
  }

  // 3. Write access_token: oauth_connection/{conn.id}/access_token
  const tokenStored = await setSecureKeyAsync(
    `oauth_connection/${connId}/access_token`,
    tokens.accessToken,
  );
  if (!tokenStored) {
    throw new Error("Failed to store access token in secure storage");
  }

  // 4. Write or clear refresh_token: oauth_connection/{conn.id}/refresh_token
  if (tokens.refreshToken) {
    await setSecureKeyAsync(
      `oauth_connection/${connId}/refresh_token`,
      tokens.refreshToken,
    );
  } else {
    // Re-auth grants that omit refresh_token must clear any stale stored
    // token — otherwise withValidToken() will attempt refresh with invalid
    // credentials.
    await deleteSecureKeyAsync(`oauth_connection/${connId}/refresh_token`);
  }

  // Run any provider-specific post-connect actions (e.g. Slack welcome DM)
  await runPostConnectHook({ service, rawTokenResponse });

  return { accountInfo: resolvedAccountInfo };
}
