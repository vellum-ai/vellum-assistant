import { getSecureKey } from "../security/secure-keys.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import { getConnectionByProvider, getProvider } from "./oauth-store.js";
import { getProviderBaseUrl } from "./provider-base-urls.js";

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

  const accessToken = getSecureKey(
    `oauth_connection/${conn.id}/access_token`,
  );

  if (!accessToken) {
    throw new Error(
      `No access token found for "${credentialService}". Authorization required.`,
    );
  }

  // Resolve base URL: prefer provider row, fall back to static map.
  const provider = getProvider(credentialService);
  const baseUrl = provider?.baseUrl ?? getProviderBaseUrl(credentialService);

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
