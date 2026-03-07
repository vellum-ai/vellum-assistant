/**
 * OAuth2 token persistence helper.
 *
 * Extracted from vault.ts so it can be reused by both the credential
 * vault tool (interactive and deferred paths) and the future OAuth
 * orchestrator without duplicating storage logic.
 */

import type {
  OAuth2FlowResult,
  TokenEndpointAuthMethod,
} from "../security/oauth2.js";
import {
  deleteSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import {
  deleteCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";
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
  /** Fallback account info from an identity verifier (e.g. Twitter @username). */
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
    `credential:${service}:access_token`,
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

  // Persist client credentials in keychain for defense in depth
  const clientIdStored = await setSecureKeyAsync(
    `credential:${service}:client_id`,
    clientId,
  );
  if (!clientIdStored) {
    throw new Error("Failed to store client_id in secure storage");
  }
  if (clientSecret) {
    const clientSecretStored = await setSecureKeyAsync(
      `credential:${service}:client_secret`,
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
    accountInfo: accountInfo ?? params.identityAccountInfo ?? null,
    oauth2TokenUrl: tokenUrl,
    oauth2ClientId: clientId,
    oauth2ClientSecret: clientSecret ?? null,
    ...(tokenEndpointAuthMethod
      ? { oauth2TokenEndpointAuthMethod: tokenEndpointAuthMethod }
      : {}),
    ...(wellKnownInjectionTemplates
      ? { injectionTemplates: wellKnownInjectionTemplates }
      : {}),
  });

  if (tokens.refreshToken) {
    const refreshStored = await setSecureKeyAsync(
      `credential:${service}:refresh_token`,
      tokens.refreshToken,
    );
    if (refreshStored) {
      upsertCredentialMetadata(service, "refresh_token", {});
    }
  } else {
    // Re-auth grants that omit refresh_token must clear any stale stored
    // token — otherwise withValidToken() will attempt refresh with invalid
    // credentials.
    await deleteSecureKeyAsync(`credential:${service}:refresh_token`);
    deleteCredentialMetadata(service, "refresh_token");
  }

  // Run any provider-specific post-connect actions (e.g. Slack welcome DM)
  await runPostConnectHook({ service, rawTokenResponse });

  return { accountInfo: accountInfo ?? params.identityAccountInfo };
}
