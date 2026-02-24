/**
 * Metadata-driven token manager for OAuth2 credentials.
 *
 * Reads refresh configuration (tokenUrl, clientId) from credential metadata
 * rather than requiring an IntegrationDefinition, enabling autonomous token
 * refresh for any OAuth2 service that stores its config in metadata.
 */

import { getSecureKey, setSecureKey } from './secure-keys.js';
import { getCredentialMetadata, upsertCredentialMetadata } from '../tools/credentials/metadata-store.js';
import { refreshOAuth2Token, type TokenEndpointAuthMethod } from './oauth2.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('token-manager');

/** Buffer before expiry to trigger proactive refresh (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class TokenExpiredError extends Error {
  constructor(public readonly service: string, message?: string) {
    super(message ?? `Token expired for "${service}". Re-authorization required.`);
    this.name = 'TokenExpiredError';
  }
}

/**
 * Check whether the access token for a service is expired or will expire
 * within the buffer window, based on the `expiresAt` field in credential metadata.
 */
function isTokenExpired(service: string): boolean {
  const meta = getCredentialMetadata(service, 'access_token');
  if (!meta?.expiresAt) return false;
  return Date.now() >= meta.expiresAt - EXPIRY_BUFFER_MS;
}

/**
 * Attempt to refresh the OAuth2 access token for a service using the
 * refresh token and OAuth2 config stored in credential metadata.
 *
 * Returns the new access token on success.
 * Throws `TokenExpiredError` if refresh is not possible.
 */
async function doRefresh(service: string): Promise<string> {
  const refreshToken = getSecureKey(`credential:${service}:refresh_token`);
  if (!refreshToken) {
    throw new TokenExpiredError(service, `No refresh token available for "${service}". Re-authorization required.`);
  }

  const meta = getCredentialMetadata(service, 'access_token');
  const tokenUrl = meta?.oauth2TokenUrl;
  const clientId = meta?.oauth2ClientId;

  if (!tokenUrl || !clientId) {
    // Legacy credentials created by the old integration flow don't store
    // oauth2TokenUrl/oauth2ClientId in metadata. The client ID is user-specific
    // (from their Google Cloud Console) and cannot be recovered, so the only
    // path forward is re-authorization via the new oauth2_connect flow.
    const isLegacy = service === 'integration:gmail' && !tokenUrl && !clientId;
    const hint = isLegacy
      ? ` This is a one-time migration: your old Gmail connection needs to be re-authorized. Ask me to "reconnect Gmail" to set it up again.`
      : '';
    throw new TokenExpiredError(
      service,
      `Missing OAuth2 refresh config for "${service}".${hint} Please reconnect via chat to re-authorize.`,
    );
  }

  const clientSecret = meta?.oauth2ClientSecret as string | undefined;
  const authMethod = meta?.oauth2TokenEndpointAuthMethod as TokenEndpointAuthMethod | undefined;
  const resolvedTokenUrl = tokenUrl;

  log.info({ service }, 'Refreshing OAuth2 access token');

  const result = await refreshOAuth2Token(resolvedTokenUrl, clientId, refreshToken, clientSecret, authMethod);

  if (!setSecureKey(`credential:${service}:access_token`, result.accessToken)) {
    throw new Error(`Failed to store refreshed access token for "${service}"`);
  }

  if (result.refreshToken) {
    if (!setSecureKey(`credential:${service}:refresh_token`, result.refreshToken)) {
      throw new Error(`Failed to store refreshed refresh token for "${service}"`);
    }
  }

  // Update metadata with new expiry.
  // Use null to explicitly clear a stale expiresAt when the provider omits
  // expires_in (or returns 0), so isTokenExpired won't keep forcing refreshes.
  const expiresAt = result.expiresIn != null && result.expiresIn > 0
    ? Date.now() + result.expiresIn * 1000
    : null;

  upsertCredentialMetadata(service, 'access_token', { expiresAt });

  log.info({ service }, 'OAuth2 access token refreshed successfully');
  return result.accessToken;
}

/**
 * Execute a callback with a valid access token for the given service.
 *
 * Handles token expiration transparently:
 * 1. Retrieves the stored access token (throws if none exists).
 * 2. If the token is expired or near-expiry, refreshes it before calling the callback.
 * 3. If the callback throws with a 401 status, attempts one refresh-and-retry cycle.
 */
export async function withValidToken<T>(
  service: string,
  callback: (token: string) => Promise<T>,
): Promise<T> {
  let token = getSecureKey(`credential:${service}:access_token`);
  if (!token) {
    const isGoogle = service === 'integration:gmail';
    const googleHint = isGoogle
      ? ' Do NOT fabricate credentials. Install and load the "google-oauth-setup" skill to set up OAuth credentials properly.'
      : '';
    throw new TokenExpiredError(service, `No access token found for "${service}". Authorization required.${googleHint}`);
  }

  // Proactively refresh if expired or about to expire.
  if (isTokenExpired(service)) {
    token = await doRefresh(service);
  }

  try {
    return await callback(token);
  } catch (err: unknown) {
    if (is401Error(err)) {
      token = await doRefresh(service);
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
