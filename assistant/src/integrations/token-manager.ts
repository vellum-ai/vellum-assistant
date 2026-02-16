/**
 * Token manager for integration OAuth2 tokens.
 *
 * Provides the ONLY way tools should access integration tokens:
 * `withValidToken(integrationId, callback)` — auto-refreshes expired
 * tokens and retries on 401 responses.
 */

import { getSecureKey, setSecureKey } from '../security/secure-keys.js';
import {
  getCredentialMetadata,
  upsertCredentialMetadata,
} from '../tools/credentials/metadata-store.js';
import { refreshOAuth2Token } from './oauth2.js';
import { getConfig } from '../config/loader.js';
import type { IntegrationDefinition } from './types.js';

/** Buffer before expiry to trigger proactive refresh (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class TokenExpiredError extends Error {
  constructor(
    public readonly integrationId: string,
    message?: string,
  ) {
    super(message ?? `Token for integration "${integrationId}" has expired and could not be refreshed. Re-authorization required.`);
    this.name = 'TokenExpiredError';
  }
}

function isTokenExpired(integrationId: string): boolean {
  const metadata = getCredentialMetadata(`integration:${integrationId}`, 'access_token');
  if (!metadata?.expiresAt) return false;
  return Date.now() >= metadata.expiresAt - EXPIRY_BUFFER_MS;
}

async function doRefresh(integrationId: string, definition: IntegrationDefinition): Promise<string> {
  const refreshToken = getSecureKey(`integration:${integrationId}:refresh_token`);
  if (!refreshToken) {
    throw new TokenExpiredError(integrationId, `No refresh token available for "${integrationId}". Re-authorization required.`);
  }

  const config = definition.oauth2Config;
  if (!config) {
    throw new TokenExpiredError(integrationId, `Integration "${integrationId}" has no OAuth2 config for token refresh.`);
  }

  // Resolve clientId from runtime config — the definition's clientId is typically
  // empty because it's supplied by the user at connect time and not baked in.
  const runtimeConfig = getConfig();
  const runtimeClientId = runtimeConfig.integrations[integrationId]?.clientId || config.clientId;
  const result = await refreshOAuth2Token(config.tokenUrl, runtimeClientId, refreshToken);

  // Store the new access token
  setSecureKey(`integration:${integrationId}:access_token`, result.accessToken);

  // Update metadata with new expiry
  const expiresAt = result.expiresIn
    ? Date.now() + result.expiresIn * 1000
    : undefined;

  upsertCredentialMetadata(`integration:${integrationId}`, 'access_token', {
    expiresAt,
  });

  // If a new refresh token was issued, store it too
  if (result.refreshToken) {
    setSecureKey(`integration:${integrationId}:refresh_token`, result.refreshToken);
    upsertCredentialMetadata(`integration:${integrationId}`, 'refresh_token', {});
  }

  return result.accessToken;
}

/**
 * Execute a callback with a valid access token for the given integration.
 *
 * This is the ONLY way tools should access integration tokens. The method:
 * 1. Reads the access token from the vault
 * 2. Checks expiry and proactively refreshes if needed
 * 3. Calls the callback with the valid token
 * 4. If the callback throws a 401-like error, attempts one refresh + retry
 */
export async function withValidToken<T>(
  integrationId: string,
  definition: IntegrationDefinition,
  callback: (token: string) => Promise<T>,
): Promise<T> {
  let token = getSecureKey(`integration:${integrationId}:access_token`);
  if (!token) {
    throw new TokenExpiredError(integrationId, `No access token found for "${integrationId}". Authorization required.`);
  }

  // Proactively refresh if expired or about to expire
  if (isTokenExpired(integrationId)) {
    try {
      token = await doRefresh(integrationId, definition);
    } catch {
      throw new TokenExpiredError(integrationId);
    }
  }

  try {
    return await callback(token);
  } catch (err: unknown) {
    // Check if this is a 401 response — attempt one refresh + retry
    if (is401Error(err)) {
      try {
        token = await doRefresh(integrationId, definition);
      } catch {
        throw new TokenExpiredError(integrationId);
      }
      return callback(token);
    }
    throw err;
  }
}

function is401Error(err: unknown): boolean {
  if (err && typeof err === 'object') {
    if ('status' in err && (err as { status: number }).status === 401) return true;
    if ('statusCode' in err && (err as { statusCode: number }).statusCode === 401) return true;
  }
  return false;
}
