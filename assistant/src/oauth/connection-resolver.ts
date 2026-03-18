import { getPlatformAssistantId } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { type Services, ServicesSchema } from "../config/schemas/services.js";
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
 * Managed providers (where the service config `mode` is `"managed"`) are
 * routed through the platform proxy with no local state required.
 *
 * BYO providers resolve from the local SQLite oauth-store and require an
 * active connection row and a stored access token.
 */
export async function resolveOAuthConnection(
  credentialService: string,
  accountInfo?: string,
): Promise<OAuthConnection> {
  const provider = getProvider(credentialService);
  const managedKey = provider?.managedServiceConfigKey;

  if (managedKey && managedKey in ServicesSchema.shape) {
    const services: Services = getConfig().services;
    if (services[managedKey as keyof Services].mode === "managed") {
      const ctx = await resolveManagedProxyContext();
      const assistantId = getPlatformAssistantId();
      return new PlatformOAuthConnection({
        id: credentialService,
        providerKey: credentialService,
        externalId: credentialService,
        accountInfo: accountInfo ?? null,
        grantedScopes: [],
        assistantId,
        platformBaseUrl: ctx.platformBaseUrl,
        apiKey: ctx.assistantApiKey,
      });
    }
  }

  // BYO path — requires a local connection row, access token, and base URL.
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

  // When credentialService is a custom override (e.g. "integration:github-work")
  // with no provider row, fall back to the app's canonical providerKey for baseUrl.
  const byoProvider =
    provider ?? getProvider(getApp(conn.oauthAppId)?.providerKey ?? "");
  const baseUrl = byoProvider?.baseUrl;
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
