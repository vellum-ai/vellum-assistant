import { getConfig } from "../config/loader.js";
import {
  getServiceMode,
  type Services,
  ServicesSchema,
} from "../config/schemas/services.js";
import { VellumPlatformClient } from "../platform/client.js";
import { getLogger } from "../util/logger.js";
import { BYOOAuthConnection } from "./byo-connection.js";
import type { OAuthConnection } from "./connection.js";
import { getConnectionAccessTokenResult } from "./credential-token-resolver.js";
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
 * @param provider - Provider identifier (e.g. "google").
 *   Maps to the `provider_key` primary key in the `oauth_providers` table.
 * @param options.clientId - Optional OAuth app client ID. When multiple BYO
 *   apps exist for the same provider, narrows the connection lookup to the
 *   app matching this client ID. Ignored for managed providers.
 * @param options.account - Optional account identifier to disambiguate
 *   multi-account connections.
 */
export async function resolveOAuthConnection(
  provider: string,
  options?: ResolveOAuthConnectionOptions,
): Promise<OAuthConnection> {
  const { clientId, account } = options ?? {};
  const providerRow = getProvider(provider);
  const managedKey = providerRow?.managedServiceConfigKey;

  if (managedKey && managedKey in ServicesSchema.shape) {
    const services: Services = getConfig().services;
    if (getServiceMode(services, managedKey as keyof Services) === "managed") {
      const client = await VellumPlatformClient.create();
      if (!client || !client.platformAssistantId) {
        const detail = !client
          ? "missing platform prerequisites"
          : "missing assistant ID";
        throw new Error(
          `Platform-managed connection for "${provider}" cannot be created: ${detail}. ` +
            `Log in to the Vellum platform or switch to using your own OAuth app.`,
        );
      }

      const connectionId = await resolvePlatformConnectionId({
        client,
        provider,
        account,
      });

      return new PlatformOAuthConnection({
        id: provider,
        provider,
        externalId: provider,
        accountInfo: account ?? null,
        client,
        connectionId,
        baseUrl: providerRow?.baseUrl ?? undefined,
      });
    }
  }

  // BYO path — requires a local connection row, access token, and base URL.
  const conn = getActiveConnection(provider, { clientId, account });
  if (!conn) {
    const filters = [
      account && `account "${account}"`,
      clientId && `client ID "${clientId}"`,
    ].filter(Boolean);
    const qualifier = filters.length
      ? ` matching ${filters.join(" and ")}`
      : "";
    throw new Error(
      `No active OAuth connection found for "${provider}"${qualifier}. Connect the service first with \`assistant oauth connect ${provider}\`.`,
    );
  }

  const tokenResult = await getConnectionAccessTokenResult({
    provider,
    connectionId: conn.id,
  });
  if (!tokenResult.value) {
    throw new Error(
      `OAuth connection for "${provider}" exists but has no access token. Re-authorize with \`assistant oauth connect ${provider}\`.`,
    );
  }

  const baseUrl = providerRow?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `OAuth provider "${provider}" has no base URL configured. Check provider setup.`,
    );
  }

  return new BYOOAuthConnection({
    id: conn.id,
    provider: conn.provider,
    baseUrl: resolveEffectiveBaseUrl(conn.provider, baseUrl, conn.metadata),
    accountInfo: conn.accountInfo,
  });
}

/**
 * Resolve the effective API base URL for a connection, preferring per-tenant
 * values stored on the connection's `metadata` over the provider's static
 * seed value when applicable.
 *
 * Salesforce is the only provider that needs this: every org has its own
 * API instance host (``acme.my.salesforce.com``, ``na162.salesforce.com``)
 * which is returned in the OAuth token response as ``instance_url`` and
 * captured into ``oauth_connection.metadata`` by ``storeOAuth2Tokens``.
 * The seed's ``baseUrl`` for Salesforce is the login domain
 * (``https://login.salesforce.com``) — correct for the OAuth handshake but
 * wrong for REST API calls. Pulling the per-connection ``instance_url``
 * here avoids forcing every caller to override ``baseUrl`` per-request.
 *
 * For all other providers the seed value is correct (single API domain),
 * so we return it unchanged.
 *
 * If a future provider needs the same treatment, generalize via a
 * declarative ``baseUrlMetadataKey`` field on the seed entry rather than
 * adding more provider-name branches here.
 */
export function resolveEffectiveBaseUrl(
  provider: string,
  fallbackBaseUrl: string,
  rawMetadata: unknown,
): string {
  if (provider !== "salesforce") return fallbackBaseUrl;

  const metadata = parseConnectionMetadata(rawMetadata);
  const instanceUrl = metadata?.instance_url;
  if (typeof instanceUrl === "string" && instanceUrl.length > 0) {
    return instanceUrl;
  }
  return fallbackBaseUrl;
}

function parseConnectionMetadata(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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

  const body = (await response.json()) as unknown;
  const connections = (
    Array.isArray(body)
      ? body
      : ((body as Record<string, unknown>).results ?? [])
  ) as Array<{ id: string; account_label?: string }>;

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
