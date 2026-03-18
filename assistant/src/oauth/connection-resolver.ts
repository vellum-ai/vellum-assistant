import { getPlatformAssistantId } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import type { Services } from "../config/schemas/services.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import {
  getApp,
  getConnectionByProvider,
  getConnectionByProviderAndAccount,
  getProvider,
} from "./oauth-store.js";
import { PlatformOAuthConnection } from "./platform-connection.js";

/**
 * Resolve an OAuthConnection for a given credential service.
 *
 * When `accountInfo` is provided, resolves the connection for that specific
 * account (e.g. "user@gmail.com"). Otherwise falls back to the most recent
 * active connection.
 *
 * Reads exclusively from the SQLite oauth-store. Throws if no connection
 * exists (authorization required).
 */
export async function resolveOAuthConnection(
  credentialService: string,
  accountInfo?: string,
): Promise<OAuthConnection> {
  const conn = accountInfo
    ? getConnectionByProviderAndAccount(credentialService, accountInfo)
    : getConnectionByProvider(credentialService);
  if (!conn) {
    throw new Error(
      `No credential found for "${credentialService}". Authorization required.`,
    );
  }

  const accessToken = await getSecureKeyAsync(
    `oauth_connection/${conn.id}/access_token`,
  );

  if (!accessToken) {
    throw new Error(
      `No access token found for "${credentialService}". Authorization required.`,
    );
  }

  // Look up the provider by credentialService first; fall back to the
  // connection's app's canonical providerKey so custom credential_service
  // overrides (e.g. "integration:github-work") still resolve to the well-known
  // provider's base URL. We traverse conn -> oauthApp -> providerKey because
  // conn.providerKey equals credentialService (getConnectionByProvider queries
  // WHERE providerKey = credentialService), whereas the app's providerKey is a
  // foreign key to the oauthProviders table.
  const provider =
    getProvider(credentialService) ??
    getProvider(getApp(conn.oauthAppId)?.providerKey ?? "");
  const baseUrl = provider?.baseUrl;

  if (!baseUrl) {
    throw new Error(`No base URL configured for "${credentialService}".`);
  }

  const grantedScopes: string[] = conn.grantedScopes
    ? JSON.parse(conn.grantedScopes)
    : [];

  const managedKey = provider?.managedServiceConfigKey;
  if (managedKey) {
    const services: Services = getConfig().services;
    const serviceConfig = services[managedKey as keyof Services];
    if (
      serviceConfig &&
      "mode" in serviceConfig &&
      serviceConfig.mode === "managed"
    ) {
      const ctx = await resolveManagedProxyContext();
      const assistantId = getPlatformAssistantId();
      if (ctx.enabled && assistantId) {
        return new PlatformOAuthConnection({
          id: conn.id,
          providerKey: conn.providerKey,
          externalId: conn.id,
          accountInfo: conn.accountInfo,
          grantedScopes,
          assistantId,
          platformBaseUrl: ctx.platformBaseUrl,
          apiKey: ctx.assistantApiKey,
        });
      }
    }
  }

  return new BYOOAuthConnection({
    id: conn.id,
    providerKey: conn.providerKey,
    baseUrl,
    accountInfo: conn.accountInfo,
    grantedScopes,
    credentialService,
  });
}
