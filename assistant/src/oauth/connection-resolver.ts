import { getSecureKey } from "../security/secure-keys.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import { getConnectionByProvider, getProvider } from "./oauth-store.js";

/**
 * Resolve an OAuthConnection for a given credential service.
 *
 * Reads exclusively from the SQLite oauth-store. Throws if no connection
 * exists (authorization required).
 */
export function resolveOAuthConnection(
  credentialService: string,
): OAuthConnection {
  const conn = getConnectionByProvider(credentialService);
  if (!conn) {
    throw new Error(
      `No credential found for "${credentialService}". Authorization required.`,
    );
  }

  const accessToken = getSecureKey(`oauth_connection/${conn.id}/access_token`);

  if (!accessToken) {
    throw new Error(
      `No access token found for "${credentialService}". Authorization required.`,
    );
  }

  // Look up the provider by credentialService first; fall back to the
  // connection's canonical providerKey so custom credential_service overrides
  // (e.g. "integration:github-work") still resolve to the well-known provider's
  // base URL.
  const provider =
    getProvider(credentialService) ?? getProvider(conn.providerKey);
  const baseUrl = provider?.baseUrl;

  if (!baseUrl) {
    throw new Error(`No base URL configured for "${credentialService}".`);
  }

  const grantedScopes: string[] = conn.grantedScopes
    ? JSON.parse(conn.grantedScopes)
    : [];

  return new BYOOAuthConnection({
    id: conn.id,
    providerKey: conn.providerKey,
    baseUrl,
    accountInfo: conn.accountInfo,
    grantedScopes,
    credentialService,
  });
}
