/**
 * OAuth2 token persistence helper.
 *
 * Extracted from vault.ts so it can be reused by both the credential
 * vault tool (interactive and deferred paths) and the future OAuth
 * orchestrator without duplicating storage logic.
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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Store OAuth2 tokens and associated metadata after a successful flow.
 *
 * Persists the access token, optional refresh token, client credentials,
 * and metadata (scopes, expiry, account info) into the secure key store
 * and credential metadata file. Runs any registered post-connect hook
 * for the service.
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

  // Write accountInfo to config using a namespaced key (dynamic import to
  // avoid circular dependencies — the config loader may transitively depend
  // on credential modules).
  const resolvedAccountInfo = accountInfo ?? params.identityAccountInfo;
  if (resolvedAccountInfo) {
    try {
      const {
        invalidateConfigCache,
        loadRawConfig,
        saveRawConfig,
        setNestedValue,
      } = await import("../config/loader.js");
      const raw = loadRawConfig();

      // Write to the namespaced path
      setNestedValue(
        raw,
        `integrations.${service}.accountInfo`,
        resolvedAccountInfo,
      );

      saveRawConfig(raw);
      invalidateConfigCache();
    } catch {
      // Non-fatal — tokens stored even if config write fails
    }
  }

  if (tokens.refreshToken) {
    const refreshStored = await setSecureKeyAsync(
      credentialKey(service, "refresh_token"),
      tokens.refreshToken,
    );
    if (refreshStored) {
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

  // Run any provider-specific post-connect actions (e.g. Slack welcome DM)
  await runPostConnectHook({ service, rawTokenResponse });

  return { accountInfo: accountInfo ?? params.identityAccountInfo };
}
