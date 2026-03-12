/**
 * OAuth2 token persistence helper.
 *
 * Extracted from vault.ts so it can be reused by both the credential
 * vault tool (interactive and deferred paths) and the future OAuth
 * orchestrator without duplicating storage logic.
 *
 * Dual-writes to both legacy stores (metadata.json, secure keys under
 * `credential/{service}/...`) AND the new SQLite tables (oauth_app,
 * oauth_connection) + new-format secure keys (`oauth_app/{id}/...`,
 * `oauth_connection/{id}/...`). The SQLite writes are best-effort —
 * failures are logged but do not block the flow.
 */

import { credentialKey, migrateKeys } from "../security/credential-key.js";
import type {
  OAuth2FlowResult,
  TokenEndpointAuthMethod,
} from "../security/oauth2.js";
import {
  deleteSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import { upsertCredentialMetadata } from "../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";
import { runPostConnectHook } from "../tools/credentials/post-connect-hooks.js";
import { getLogger } from "../util/logger.js";
import {
  createConnection,
  getConnectionByProvider,
  updateConnection,
  upsertApp,
} from "./oauth-store.js";

const log = getLogger("token-persistence");

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
 * and metadata (scopes, expiry, account info) into the secure key store
 * and credential metadata file. Dual-writes to the new SQLite oauth_app /
 * oauth_connection tables with new-format secure keys. Runs any registered
 * post-connect hook for the service.
 */
export async function storeOAuth2Tokens(
  params: StoreOAuth2TokensParams,
): Promise<{ accountInfo?: string }> {
  migrateKeys();

  const {
    service,
    tokens,
    grantedScopes,
    rawTokenResponse,
    clientId,
    clientSecret,
    tokenUrl,
    tokenEndpointAuthMethod,
    userinfoUrl,
    allowedTools,
    wellKnownInjectionTemplates,
  } = params;

  // ----- Legacy: store access_token under credential/{service}/access_token -----
  const tokenStored = await setSecureKeyAsync(
    credentialKey(service, "access_token"),
    tokens.accessToken,
  );
  if (!tokenStored) {
    throw new Error("Failed to store access token in secure storage");
  }

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

  // ----- Legacy: store client_secret under credential/{service}/client_secret -----
  // client_id is stored in metadata only (oauth2ClientId field) — not the
  // secure store. token-manager.ts reads it from meta?.oauth2ClientId.
  if (clientSecret) {
    const clientSecretStored = await setSecureKeyAsync(
      credentialKey(service, "client_secret"),
      clientSecret,
    );
    if (!clientSecretStored) {
      throw new Error("Failed to store client_secret in secure storage");
    }
  }

  // ----- Legacy: credential metadata -----
  upsertCredentialMetadata(service, "access_token", {
    allowedTools: allowedTools ?? [],
    expiresAt,
    grantedScopes,
    oauth2TokenUrl: tokenUrl,
    oauth2ClientId: clientId,
    ...(tokenEndpointAuthMethod
      ? { oauth2TokenEndpointAuthMethod: tokenEndpointAuthMethod }
      : {}),
    ...(wellKnownInjectionTemplates
      ? { injectionTemplates: wellKnownInjectionTemplates }
      : {}),
  });

  const resolvedAccountInfo = accountInfo ?? params.identityAccountInfo;

  // ----- Legacy: refresh token -----
  let hasRefreshToken = false;
  if (tokens.refreshToken) {
    const refreshStored = await setSecureKeyAsync(
      credentialKey(service, "refresh_token"),
      tokens.refreshToken,
    );
    if (refreshStored) {
      hasRefreshToken = true;
      upsertCredentialMetadata(service, "access_token", {
        hasRefreshToken: true,
      });
    }
  } else {
    // Re-auth grants that omit refresh_token must clear any stale stored
    // token — otherwise withValidToken() will attempt refresh with invalid
    // credentials.
    await deleteSecureKeyAsync(credentialKey(service, "refresh_token"));
    upsertCredentialMetadata(service, "access_token", {
      hasRefreshToken: false,
    });
  }

  // -------------------------------------------------------------------
  // SQLite dual-write: oauth_app + oauth_connection + new-format keys
  // -------------------------------------------------------------------
  // Best-effort — failures are logged but do not block the flow. The
  // legacy stores above are the source of truth until migration is complete.
  await persistToOAuthStore({
    service,
    clientId,
    clientSecret,
    tokens,
    grantedScopes,
    rawTokenResponse,
    expiresAt: expiresAt ?? undefined,
    hasRefreshToken,
    resolvedAccountInfo,
    oauthAppId: params.oauthAppId,
  });

  // Run any provider-specific post-connect actions (e.g. Slack welcome DM)
  await runPostConnectHook({ service, rawTokenResponse });

  return { accountInfo: resolvedAccountInfo };
}

// ---------------------------------------------------------------------------
// SQLite dual-write helper
// ---------------------------------------------------------------------------

async function persistToOAuthStore(params: {
  service: string;
  clientId: string;
  clientSecret?: string;
  tokens: OAuth2FlowResult["tokens"];
  grantedScopes: string[];
  rawTokenResponse: Record<string, unknown>;
  expiresAt?: number;
  hasRefreshToken: boolean;
  resolvedAccountInfo?: string;
  oauthAppId?: string;
}): Promise<void> {
  try {
    const {
      service,
      clientId,
      clientSecret,
      tokens,
      grantedScopes,
      rawTokenResponse,
      expiresAt,
      hasRefreshToken,
      resolvedAccountInfo,
    } = params;

    // 1. Upsert the oauth_app row (or use the pre-resolved ID).
    const app = params.oauthAppId
      ? { id: params.oauthAppId }
      : upsertApp(service, clientId);

    // 2. Dual-write client_secret to new key format:
    //    oauth_app/{app.id}/client_secret
    if (clientSecret) {
      await setSecureKeyAsync(
        `oauth_app/${app.id}/client_secret`,
        clientSecret,
      );
    }

    // 3. Upsert oauth_connection — reuse existing active connection for this
    //    provider, or create a new one.
    const existingConn = getConnectionByProvider(service);
    let connId: string;

    if (existingConn) {
      connId = existingConn.id;
      updateConnection(connId, {
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
        expiresAt,
        hasRefreshToken,
        metadata: rawTokenResponse,
      });
      connId = conn.id;
    }

    // 4. Dual-write access_token to new key format:
    //    oauth_connection/{conn.id}/access_token
    await setSecureKeyAsync(
      `oauth_connection/${connId}/access_token`,
      tokens.accessToken,
    );

    // 5. Dual-write refresh_token to new key format (if present):
    //    oauth_connection/{conn.id}/refresh_token
    if (tokens.refreshToken) {
      await setSecureKeyAsync(
        `oauth_connection/${connId}/refresh_token`,
        tokens.refreshToken,
      );
    }
  } catch (err) {
    // Non-fatal — legacy stores are already populated above. Log and
    // continue so the OAuth flow completes successfully.
    log.warn({ err }, "Failed to dual-write to OAuth SQLite store");
  }
}
