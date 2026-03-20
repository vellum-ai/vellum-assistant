import { getConfig } from "../config/loader.js";
import { type Services, ServicesSchema } from "../config/schemas/services.js";
import { VellumPlatformClient } from "../platform/client.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import { getActiveConnection, getProvider } from "./oauth-store.js";
import { PlatformOAuthConnection } from "./platform-connection.js";

const log = getLogger("connection-resolver");

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
      const client = await VellumPlatformClient.create();
      if (!client || !client.platformAssistantId) {
        const detail = !client
          ? "missing platform prerequisites"
          : "missing assistant ID";
        throw new Error(
          `Platform-managed connection for "${providerKey}" cannot be created: ${detail}. ` +
            `Log in to the Vellum platform or switch to using your own OAuth app.`,
        );
      }

      const providerSlug = providerKey.replace(/^integration:/, "");

      const connectionId = await resolvePlatformConnectionId({
        client,
        provider: providerSlug,
        account,
      });

      return new PlatformOAuthConnection({
        id: providerKey,
        providerKey,
        externalId: providerKey,
        accountInfo: account ?? null,
        client,
        connectionId,
      });
    }
  }

  // BYO path — requires a local connection row, access token, and base URL.
  const conn = getActiveConnection(providerKey, { clientId, account });
  if (!conn) {
    const filters = [
      account && `account "${account}"`,
      clientId && `client ID "${clientId}"`,
    ].filter(Boolean);
    const qualifier = filters.length
      ? ` matching ${filters.join(" and ")}`
      : "";
    throw new Error(
      `No active OAuth connection found for "${providerKey}"${qualifier}. Connect the service first with oauth2_connect.`,
    );
  }

  const accessToken = await getSecureKeyAsync(
    `oauth_connection/${conn.id}/access_token`,
  );
  if (!accessToken) {
    throw new Error(
      `OAuth connection for "${providerKey}" exists but has no access token. Re-authorize with oauth2_connect.`,
    );
  }

  const baseUrl = provider?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `OAuth provider "${providerKey}" has no base URL configured. Check provider setup.`,
    );
  }

  return new BYOOAuthConnection({
    id: conn.id,
    providerKey: conn.providerKey,
    baseUrl,
    accountInfo: conn.accountInfo,
  });
}

// ---------------------------------------------------------------------------
// Platform connection ID resolution
// ---------------------------------------------------------------------------

interface ResolvePlatformConnectionIdOptions {
  client: VellumPlatformClient;
  provider: string;
  account?: string;
}

/**
 * Fetch the platform-side connection ID for a managed provider by calling
 * the List Connections endpoint.
 */
async function resolvePlatformConnectionId(
  options: ResolvePlatformConnectionIdOptions,
): Promise<string> {
  const { client, provider, account } = options;

  const params = new URLSearchParams();
  params.set("provider", provider);
  params.set("status", "ACTIVE");
  if (account) {
    params.set("account_identifier", account);
  }

  const path = `/v1/assistants/${client.platformAssistantId}/oauth/connections/?${params.toString()}`;
  const response = await client.fetch(path);

  if (!response.ok) {
    log.error(
      { status: response.status, provider },
      "Failed to list platform OAuth connections",
    );
    throw new Error(
      `Failed to resolve platform connection for "${provider}": HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as {
    results?: Array<{ id: string; account_label?: string }>;
  };
  const connections = body.results ?? [];

  if (connections.length === 0) {
    throw new Error(
      `No active platform OAuth connection found for provider "${provider}"` +
        (account ? ` with account "${account}"` : "") +
        ". Connect the service on the Vellum platform first.",
    );
  }

  if (connections.length > 1 && !account) {
    log.warn(
      {
        provider,
        count: connections.length,
        selectedId: connections[0].id,
      },
      "Multiple active platform connections found; using the most recently created. " +
        "Pass an account option to select a specific connection.",
    );
  }

  return connections[0].id;
}
