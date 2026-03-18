import { getPlatformAssistantId } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { type Services, ServicesSchema } from "../config/schemas/services.js";
import { resolveManagedProxyContext } from "../providers/managed-proxy/context.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import {
  getConnectionByProvider,
  getConnectionByProviderAndAccount,
  getProvider,
} from "./oauth-store.js";
import { PlatformOAuthConnection } from "./platform-connection.js";

export interface ResolveOAuthConnectionOptions {
  /** OAuth app client ID — narrows to a specific app when multiple BYO apps
   *  exist for the same provider. */
  clientId?: string;
  /** Account identifier (e.g. email, username) — disambiguates when multiple
   *  accounts are connected for the same provider. Best-effort: not guaranteed
   *  to be present on all connections. */
  account?: string;
}

/**
 * Resolve an OAuthConnection for a given provider.
 *
 * Managed providers (where the service config `mode` is `"managed"`) are
 * routed through the platform proxy with no local state required.
 *
 * BYO providers resolve from the local SQLite oauth-store and require an
 * active connection row and a stored access token.
 *
 * @param providerKey - Provider identifier (e.g. "integration:google").
 *   Maps to the `provider_key` primary key in the `oauth_providers` table.
 * @param options.clientId - Optional OAuth app client ID. When multiple BYO
 *   apps exist for the same provider, narrows the connection lookup to the
 *   app matching this client ID. Ignored for managed providers.
 * @param options.account - Optional account identifier to disambiguate
 *   multi-account connections.
 */
export async function resolveOAuthConnection(
  providerKey: string,
  options?: ResolveOAuthConnectionOptions,
): Promise<OAuthConnection> {
  const { clientId, account } = options ?? {};
  const provider = getProvider(providerKey);
  const managedKey = provider?.managedServiceConfigKey;

  if (managedKey && managedKey in ServicesSchema.shape) {
    const services: Services = getConfig().services;
    if (services[managedKey as keyof Services].mode === "managed") {
      const ctx = await resolveManagedProxyContext();
      const assistantId = getPlatformAssistantId();
      return new PlatformOAuthConnection({
        id: providerKey,
        providerKey,
        externalId: providerKey,
        accountInfo: account ?? null,
        grantedScopes: [],
        assistantId,
        platformBaseUrl: ctx.platformBaseUrl,
        apiKey: ctx.assistantApiKey,
      });
    }
  }

  // BYO path — requires a local connection row, access token, and base URL.
  const conn = account
    ? getConnectionByProviderAndAccount(providerKey, account, clientId)
    : getConnectionByProvider(providerKey, clientId);
  if (!conn) {
    throw new Error(
      `No credential found for "${providerKey}". Authorization required.`,
    );
  }

  const accessToken = await getSecureKeyAsync(
    `oauth_connection/${conn.id}/access_token`,
  );
  if (!accessToken) {
    throw new Error(
      `No access token found for "${providerKey}". Authorization required.`,
    );
  }

  const baseUrl = provider?.baseUrl;
  if (!baseUrl) {
    throw new Error(`No base URL configured for "${providerKey}".`);
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
  });
}
