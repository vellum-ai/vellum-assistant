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
import { syncManualTokenConnection } from "./manual-token-connection.js";
import { getActiveConnections, getProvider } from "./oauth-store.js";
import { PlatformOAuthConnection } from "./platform-connection.js";
import { scopeDifference } from "./scope-utils.js";

const log = getLogger("connection-resolver");

export interface ResolveOAuthConnectionOptions {
  /** OAuth app client ID — narrows to a specific app when multiple BYO apps
   *  exist for the same provider. */
  clientId?: string;
  /** Account identifier (e.g. email, username) — disambiguates when multiple
   *  accounts are connected for the same provider. Best-effort: not guaranteed
   *  to be present on all connections. */
  account?: string;
  /**
   * Scopes the caller needs the connection to actually carry. A single provider
   * key can bundle several products behind one OAuth app (notably Google: Gmail
   * + Calendar + Drive), and a connection may have been granted only a subset.
   * When set, resolution prefers a connection whose granted scopes cover these,
   * and fails with an actionable "reconnect to grant X" error — instead of
   * returning a token that 403s downstream — when the only active connection(s)
   * positively lack a required scope. Scope data that is simply unknown never
   * blocks (see {@link selectConnectionByScopes}).
   */
  requiredScopes?: string[];
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
  const { clientId, account, requiredScopes } = options ?? {};
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
        requiredScopes,
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
  if (providerRow?.authorizeUrl === "urn:manual-token") {
    await syncManualTokenConnection(provider);
  }

  const candidates = getActiveConnections(provider, { clientId, account });
  if (candidates.length === 0) {
    const filters = [
      account && `account "${account}"`,
      clientId && `client ID "${clientId}"`,
    ].filter(Boolean);
    const qualifier = filters.length
      ? ` matching ${filters.join(" and ")}`
      : "";
    throw new Error(
      `No active OAuth connection found for "${provider}"${qualifier}. The ${provider} service needs to be connected before it can be used.`,
    );
  }

  // Scope guard: when the caller needs specific scopes, pick a connection that
  // actually carries them rather than blindly taking the newest row — a user
  // may hold several active connections (e.g. one Calendar-only, one full).
  // Only fail when EVERY active connection positively lacks a required scope;
  // unknown scope data never blocks. Without requiredScopes, behavior is
  // unchanged: take the most-recently-created connection.
  let conn = candidates[0];
  if (requiredScopes?.length) {
    const { eligible, missingScopes } = partitionByScopes(
      candidates,
      requiredScopes,
      (row) => parseGrantedScopes(row.grantedScopes),
    );
    if (eligible.length === 0) {
      throw new Error(missingScopesMessage(provider, missingScopes));
    }
    conn = eligible[0];
  }

  const tokenResult = await getConnectionAccessTokenResult({
    provider,
    connectionId: conn.id,
  });
  if (!tokenResult.value) {
    throw new Error(
      `OAuth connection for "${provider}" exists but the access token is missing or expired. The ${provider} service needs to be reconnected.`,
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
  requiredScopes?: string[];
}

interface PlatformConnectionEntry {
  id: string;
  account_label?: string | null;
  /** Scopes the platform actually granted this connection. May be absent for
   *  older connections or providers that don't report scopes. */
  scopes_granted?: string[] | null;
}

/**
 * Fetch active platform connections for a managed provider by calling the
 * List Connections endpoint.
 */
async function fetchPlatformConnections(options: {
  client: VellumPlatformClient;
  provider: string;
  accountIdentifier?: string;
}): Promise<PlatformConnectionEntry[]> {
  const { client, provider, accountIdentifier } = options;
  const params = new URLSearchParams();
  params.set("provider", provider);
  params.set("status", "ACTIVE");
  if (accountIdentifier) {
    params.set("account_identifier", accountIdentifier);
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
  ) as PlatformConnectionEntry[];
  return connections;
}

/**
 * Fetch the platform-side connection ID for a managed provider by calling
 * the List Connections endpoint.
 */
async function resolvePlatformConnectionId(
  options: ResolvePlatformConnectionIdOptions,
): Promise<string> {
  const { client, provider, account, requiredScopes } = options;

  let connections = await fetchPlatformConnections({
    client,
    provider,
    accountIdentifier: account,
  });

  if (account && connections.length === 0) {
    const unfilteredConnections = await fetchPlatformConnections({
      client,
      provider,
    });
    connections = unfilteredConnections.filter(
      (connection) =>
        connection.account_label === account || connection.id === account,
    );
  }

  if (connections.length === 0) {
    throw new Error(
      `No active OAuth connection found for provider "${provider}"` +
        (account ? ` with account "${account}"` : "") +
        `. The ${provider} service needs to be connected.`,
    );
  }

  // Narrow to connections that actually carry the scopes the caller needs.
  // This is what keeps a narrowly-scoped Google connection (e.g. Calendar-only,
  // created by the onboarding check-in flow) from being resolved as a full
  // Gmail connection and 403-ing on the first Gmail API call.
  if (requiredScopes?.length) {
    const { eligible, missingScopes } = partitionByScopes(
      connections,
      requiredScopes,
      (c) => c.scopes_granted ?? [],
    );
    if (eligible.length === 0) {
      log.warn(
        { provider, count: connections.length, requiredScopes, missingScopes },
        "Active platform connection(s) found but none carry the required scopes",
      );
      throw new Error(missingScopesMessage(provider, missingScopes));
    }
    connections = eligible;
  }

  if (connections.length > 1 && !account) {
    const allAccounts = connections
      .map((c) => c.account_label ?? c.id)
      .join(", ");
    log.warn(
      {
        provider,
        count: connections.length,
        selectedId: connections[0].id,
        allAccounts,
      },
      "Multiple active platform connections found; using the most recently created. " +
        "Pass an account option to select a specific connection.",
    );
  }

  return connections[0].id;
}

/**
 * Partition connections into those eligible to serve a request needing
 * `requiredScopes` versus the scopes positively missing across all of them.
 *
 * Scope data can be absent (older connections, providers that don't report
 * granted scopes). We only ever REJECT a connection when we can positively see
 * its granted-scope set AND that set is missing a required scope — never when
 * scope data is simply unknown. This keeps the check from breaking existing
 * working connections while still catching the real failure mode: a narrowly-
 * scoped connection masquerading as a fully-capable one.
 *
 * `eligible` is ordered scope-satisfying first, then scope-unknown, preserving
 * the caller's most-recent-first ordering within each group, so `eligible[0]`
 * is the best connection to use. `missingScopes` is only meaningful when
 * `eligible` is empty (every connection positively lacked a required scope).
 */
function partitionByScopes<T>(
  items: T[],
  requiredScopes: string[],
  getGranted: (item: T) => string[],
): { eligible: T[]; missingScopes: string[] } {
  const satisfying: T[] = [];
  const scopeUnknown: T[] = [];
  const missingPerItem: string[][] = [];

  for (const item of items) {
    const granted = getGranted(item);
    if (granted.length === 0) {
      // Unknown scope coverage — don't block on it.
      scopeUnknown.push(item);
      continue;
    }
    const missing = scopeDifference(requiredScopes, granted);
    if (missing.length === 0) {
      satisfying.push(item);
    } else {
      missingPerItem.push(missing);
    }
  }

  return {
    eligible: [...satisfying, ...scopeUnknown],
    missingScopes: Array.from(new Set(missingPerItem.flat())),
  };
}

/** Best-effort parse of a connection row's JSON-encoded granted-scopes column. */
function parseGrantedScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

/** Actionable error shown when a connection is missing required scopes. */
function missingScopesMessage(
  provider: string,
  missingScopes: string[],
): string {
  return (
    `Your ${provider} account is connected but is missing required access ` +
    `(${missingScopes.join(", ")}). Reconnect ${provider} and grant the ` +
    `missing permission to continue.`
  );
}
