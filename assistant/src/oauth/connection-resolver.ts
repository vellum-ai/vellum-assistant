import { getCredentialMetadata } from "../tools/credentials/metadata-store.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import { getProviderBaseUrl } from "./provider-base-urls.js";

/**
 * Resolve an OAuthConnection for a given credential service.
 * Currently always creates a BYO connection from existing credential store.
 * Will be extended to create Platform connections when storage model supports it.
 */
export function resolveOAuthConnection(
  credentialService: string,
): OAuthConnection {
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
