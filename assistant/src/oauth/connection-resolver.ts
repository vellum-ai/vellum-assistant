import { credentialKey } from "../security/credential-key.js";
import { getSecureKey } from "../security/secure-keys.js";
import { getCredentialMetadata } from "../tools/credentials/metadata-store.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import { getConnectionByProvider, getProvider } from "./oauth-store.js";
import { getProviderBaseUrl } from "./provider-base-urls.js";

/**
 * Resolve an OAuthConnection for a given credential service.
 *
 * Tries the new SQLite oauth-store first (connections created after the
 * migration). Falls back to the legacy credential metadata store for
 * pre-migration connections.
 */
export function resolveOAuthConnection(
  credentialService: string,
): OAuthConnection {
  // ----- New path: SQLite oauth-store -----
  const conn = getConnectionByProvider(credentialService);
  if (conn) {
    // Read access_token from new key format, falling back to legacy key.
    const accessToken =
      getSecureKey(`oauth_connection/${conn.id}/access_token`) ??
      getSecureKey(credentialKey(credentialService, "access_token"));

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

  // ----- Legacy path: credential metadata store -----
  const meta = getCredentialMetadata(credentialService, "access_token");
  if (!meta) {
    throw new Error(
      `No credential found for "${credentialService}". Authorization required.`,
    );
  }

  const baseUrl = getProviderBaseUrl(credentialService);
  if (!baseUrl) {
    throw new Error(`No base URL configured for "${credentialService}".`);
  }

  return new BYOOAuthConnection({
    id: meta.credentialId,
    providerKey: credentialService,
    baseUrl,
    accountInfo: null,
    grantedScopes: meta.grantedScopes ?? [],
    credentialService,
  });
}
