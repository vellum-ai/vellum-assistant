/**
 * Proactive credential health monitoring.
 *
 * Enumerates all active OAuth connections and validates each one for:
 * - Token presence in secure storage
 * - Token expiry (expired or expiring within the warning window)
 * - Scope coverage (grantedScopes vs provider defaultScopes)
 * - Liveness ping (for providers with a pingUrl)
 *
 * Designed to run during the heartbeat cycle. All checks are diagnostic —
 * no token refresh or recovery is attempted.
 */

import { isTokenExpired } from "@vellumai/credential-storage";

import type { Services } from "../config/schemas/services.js";
import { getConnectionAccessTokenResult } from "../oauth/credential-token-resolver.js";
import {
  getProvider,
  listActiveConnectionsByProvider,
  listProviders,
  type OAuthConnectionRow,
  type OAuthProviderRow,
} from "../oauth/oauth-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("credential-health");

/** 7 days in milliseconds — warn if token expires within this window. */
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** Timeout for liveness pings. */
const PING_TIMEOUT_MS = 5_000;

// ── Types ─────────────────────────────────────────────────────────────

export type CredentialHealthStatus =
  | "healthy"
  | "expiring"
  | "expired"
  | "missing_token"
  | "unreachable"
  | "missing_scopes"
  | "revoked"
  | "ping_failed";

export interface CredentialHealthResult {
  connectionId: string;
  provider: string;
  accountInfo: string | null;
  status: CredentialHealthStatus;
  details: string;
  missingScopes: string[];
  canAutoRecover: boolean;
}

export interface CredentialHealthReport {
  checkedAt: number;
  results: CredentialHealthResult[];
  unhealthy: CredentialHealthResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function scopeDifference(required: string[], granted: string[]): string[] {
  const grantedSet = new Set(granted);
  return required.filter((s) => !grantedSet.has(s));
}

// ── Liveness ping ─────────────────────────────────────────────────────

/** @internal Exposed for test injection. */
let _fetchFn: typeof fetch = fetch;

/** @internal Test-only: override the fetch function used for pings. */
export function _setFetchFn(fn: typeof fetch): void {
  _fetchFn = fn;
}

async function pingProvider(
  token: string,
  pingUrl: string,
  pingMethod: string | null,
  pingHeaders: string | null,
  pingBody: string | null,
): Promise<{ ok: boolean; authError: boolean }> {
  const method = pingMethod ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...safeJsonParse<Record<string, string>>(pingHeaders, {}),
  };

  const body =
    method !== "GET" && pingBody
      ? typeof pingBody === "string"
        ? pingBody
        : JSON.stringify(pingBody)
      : undefined;

  try {
    const response = await _fetchFn(pingUrl, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });

    if (response.ok) return { ok: true, authError: false };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, authError: true };
    }
    return { ok: false, authError: false };
  } catch {
    // Network error or timeout — treat as non-auth failure
    return { ok: false, authError: false };
  }
}

// ── Core check ────────────────────────────────────────────────────────

interface CheckConnectionOpts {
  connectionId: string;
  provider: string;
  accountInfo: string | null;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  grantedScopesRaw: string;
  defaultScopesRaw: string;
  pingUrl: string | null;
  pingMethod: string | null;
  pingHeaders: string | null;
  pingBody: string | null;
}

async function checkConnection(
  opts: CheckConnectionOpts,
): Promise<CredentialHealthResult> {
  const {
    connectionId,
    provider,
    accountInfo,
    expiresAt,
    hasRefreshToken,
    grantedScopesRaw,
    defaultScopesRaw,
    pingUrl,
    pingMethod,
    pingHeaders,
    pingBody,
  } = opts;

  const base = {
    connectionId,
    provider,
    accountInfo,
    missingScopes: [] as string[],
  };

  // 1. Check token presence via the centralized resolver. Manual-token
  // providers (e.g. slack_channel, telegram) store their primary token at
  // credential/<provider>/<field> rather than oauth_connection/<id>/access_token;
  // the resolver handles the mapping automatically.
  const tokenResult = await getConnectionAccessTokenResult({
    provider,
    connectionId,
  });
  if (!tokenResult.value) {
    if (tokenResult.unreachable) {
      return {
        ...base,
        status: "unreachable",
        details: `Credential backend is temporarily unreachable for ${provider}. Token status unknown.`,
        canAutoRecover: true,
      };
    }
    return {
      ...base,
      status: "missing_token",
      details: `No access token found for ${provider}. Re-authorization required.`,
      canAutoRecover: false,
    };
  }
  const token = tokenResult.value;

  // 2. Check token expiry
  if (isTokenExpired(expiresAt)) {
    return {
      ...base,
      status: hasRefreshToken ? "expiring" : "expired",
      details: hasRefreshToken
        ? `Token for ${provider} is expired but has a refresh token — auto-recovery may work.`
        : `Token for ${provider} is expired with no refresh token. Re-authorization required.`,
      canAutoRecover: hasRefreshToken,
    };
  }

  // Check if expiring within warning window (but not yet expired by the 5-min buffer)
  if (expiresAt && Date.now() >= expiresAt - EXPIRY_WARNING_MS) {
    // Token works now but will expire soon
    if (!hasRefreshToken) {
      return {
        ...base,
        status: "expiring",
        details: `Token for ${provider} expires within 7 days and has no refresh token. Re-authorization will be needed soon.`,
        canAutoRecover: false,
      };
    }
    // Has refresh token — not an issue, auto-refresh will handle it
  }

  // 3. Check scope coverage
  const grantedScopes = safeJsonParse<string[]>(grantedScopesRaw, []);
  const defaultScopes = safeJsonParse<string[]>(defaultScopesRaw, []);
  if (defaultScopes.length > 0 && grantedScopes.length > 0) {
    const missing = scopeDifference(defaultScopes, grantedScopes);
    if (missing.length > 0) {
      return {
        ...base,
        status: "missing_scopes",
        details: `${provider} is missing required scopes: ${missing.join(", ")}. Features may not work correctly.`,
        missingScopes: missing,
        canAutoRecover: false,
      };
    }
  }

  // 4. Liveness ping
  if (pingUrl) {
    const pingResult = await pingProvider(
      token,
      pingUrl,
      pingMethod,
      pingHeaders,
      pingBody,
    );
    if (!pingResult.ok) {
      if (pingResult.authError) {
        return {
          ...base,
          status: "revoked",
          details: `${provider} token was rejected (401/403). The token may have been revoked. Re-authorization required.`,
          canAutoRecover: false,
        };
      }
      // Non-auth ping failure — log but don't mark as critical.
      // Could be a transient API issue.
      log.debug(
        { provider, connectionId },
        "Credential ping failed with non-auth error",
      );
      return {
        ...base,
        status: "ping_failed",
        details: `${provider} liveness check failed (non-auth error). This may be transient.`,
        canAutoRecover: false,
      };
    }
  }

  return {
    ...base,
    status: "healthy",
    details: `${provider} credential is healthy.`,
    canAutoRecover: hasRefreshToken,
  };
}

// ── Managed provider checks ──────────────────────────────────────────

/**
 * Check whether a provider is configured in managed mode.
 * Uses dynamic imports to avoid circular dependencies (same pattern as
 * `integration-status.ts`).
 */
async function isManagedProvider(
  providerRow: OAuthProviderRow,
): Promise<boolean> {
  const managedKey = providerRow.managedServiceConfigKey;
  if (!managedKey) return false;

  try {
    const { ServicesSchema, getServiceMode } =
      await import("../config/schemas/services.js");
    if (!(managedKey in ServicesSchema.shape)) return false;

    const { getConfig } = await import("../config/loader.js");
    const services: Services = getConfig().services;
    return getServiceMode(services, managedKey as keyof Services) === "managed";
  } catch {
    return false;
  }
}

/**
 * Fetch active managed connections from the platform and ping each one.
 * Returns health results for managed connections, or an empty array if
 * the platform is unreachable or the provider is not managed.
 */
async function checkManagedProvider(
  providerRow: OAuthProviderRow,
): Promise<CredentialHealthResult[]> {
  const results: CredentialHealthResult[] = [];

  try {
    const { VellumPlatformClient } = await import("../platform/client.js");
    const client = await VellumPlatformClient.create();
    if (!client?.platformAssistantId) return results;

    const params = new URLSearchParams();
    params.set("provider", providerRow.provider);
    params.set("status", "ACTIVE");

    const path = `/v1/assistants/${encodeURIComponent(client.platformAssistantId)}/oauth/connections/?${params.toString()}`;
    const response = await client.fetch(path);

    if (!response.ok) {
      log.warn(
        { status: response.status, provider: providerRow.provider },
        "Failed to list managed connections for health check",
      );
      return results;
    }

    const body = (await response.json()) as unknown;
    const connections = (
      Array.isArray(body)
        ? body
        : ((body as Record<string, unknown>).results ?? [])
    ) as Array<{ id: string; account_label?: string }>;

    if (connections.length === 0) {
      // No active managed connections — report as missing so the
      // heartbeat can notify the user.
      results.push({
        connectionId: `managed:${providerRow.provider}`,
        provider: providerRow.provider,
        accountInfo: null,
        status: "missing_token",
        details: `No active managed connection for ${providerRow.provider}. Reconnect on the Vellum platform.`,
        missingScopes: [],
        canAutoRecover: false,
      });
      return results;
    }

    // Ping each managed connection via the platform proxy
    for (const conn of connections) {
      const base: Omit<
        CredentialHealthResult,
        "status" | "details" | "canAutoRecover"
      > = {
        connectionId: conn.id,
        provider: providerRow.provider,
        accountInfo: conn.account_label ?? null,
        missingScopes: [],
      };

      if (!providerRow.pingUrl) {
        // No ping URL configured — assume healthy if connection exists
        results.push({
          ...base,
          status: "healthy",
          details: `${providerRow.provider} managed connection is active (no ping URL configured).`,
          canAutoRecover: true,
        });
        continue;
      }

      // Ping via platform proxy
      try {
        const { PlatformOAuthConnection } =
          await import("../oauth/platform-connection.js");
        const platformConn = new PlatformOAuthConnection({
          id: conn.id,
          provider: providerRow.provider,
          externalId: providerRow.provider,
          accountInfo: conn.account_label ?? null,
          client,
          connectionId: conn.id,
          baseUrl: undefined,
        });

        const pingResp = await platformConn.request({
          method: providerRow.pingMethod ?? "GET",
          path: providerRow.pingUrl,
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });

        if (pingResp.status >= 200 && pingResp.status < 300) {
          results.push({
            ...base,
            status: "healthy",
            details: `${providerRow.provider} managed credential is healthy.`,
            canAutoRecover: true,
          });
        } else if (pingResp.status === 401 || pingResp.status === 403) {
          results.push({
            ...base,
            status: "revoked",
            details: `${providerRow.provider} managed token was rejected (${pingResp.status}). Reconnect on the Vellum platform.`,
            canAutoRecover: false,
          });
        } else {
          results.push({
            ...base,
            status: "ping_failed",
            details: `${providerRow.provider} managed liveness check returned ${pingResp.status}.`,
            canAutoRecover: false,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // CredentialRequiredError means the platform can't materialize
        // the token — treat as revoked.
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          (err as { name: string }).name === "CredentialRequiredError"
        ) {
          results.push({
            ...base,
            status: "revoked",
            details: `${providerRow.provider} managed connection is no longer valid. Reconnect on the Vellum platform.`,
            canAutoRecover: false,
          });
        } else {
          log.debug(
            { provider: providerRow.provider, connectionId: conn.id, err: msg },
            "Managed credential ping failed",
          );
          results.push({
            ...base,
            status: "ping_failed",
            details: `${providerRow.provider} managed liveness check failed: ${msg}`,
            canAutoRecover: false,
          });
        }
      }
    }
  } catch (err) {
    log.warn(
      { err, provider: providerRow.provider },
      "Failed to check managed provider health",
    );
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check the health of all active OAuth connections.
 *
 * Iterates every registered provider, looks up active connections, and
 * validates each one. Returns a structured report with overall results
 * and a filtered list of unhealthy credentials.
 *
 * Checks both BYO (local SQLite) and managed (platform-hosted)
 * connections.
 */
export async function checkAllCredentials(): Promise<CredentialHealthReport> {
  const checkedAt = Date.now();
  const results: CredentialHealthResult[] = [];

  let providers;
  try {
    providers = listProviders();
  } catch (err) {
    log.warn({ err }, "Failed to list OAuth providers");
    return { checkedAt, results, unhealthy: [] };
  }

  // Track which providers have BYO connections so we skip the managed
  // check for them (they're already covered by the BYO path).
  const byoProviders = new Set<string>();

  for (const providerRow of providers) {
    let connections;
    try {
      connections = listActiveConnectionsByProvider(providerRow.provider);
    } catch (err) {
      log.warn(
        { err, provider: providerRow.provider },
        "Failed to list connections for provider",
      );
      continue;
    }

    if (connections.length > 0) {
      byoProviders.add(providerRow.provider);
    }

    for (const conn of connections) {
      try {
        const result = await checkConnection({
          connectionId: conn.id,
          provider: conn.provider,
          accountInfo: conn.accountInfo,
          expiresAt: conn.expiresAt,
          hasRefreshToken: !!conn.hasRefreshToken,
          grantedScopesRaw: conn.grantedScopes,
          defaultScopesRaw: providerRow.defaultScopes,
          pingUrl: providerRow.pingUrl,
          pingMethod: providerRow.pingMethod,
          pingHeaders: providerRow.pingHeaders,
          pingBody: providerRow.pingBody,
        });
        results.push(result);
      } catch (err) {
        log.warn(
          { err, provider: conn.provider, connectionId: conn.id },
          "Failed to check credential health",
        );
      }
    }
  }

  // Check managed connections for providers without BYO connections.
  for (const providerRow of providers) {
    if (byoProviders.has(providerRow.provider)) continue;
    if (!(await isManagedProvider(providerRow))) continue;

    try {
      const managedResults = await checkManagedProvider(providerRow);
      results.push(...managedResults);
    } catch (err) {
      log.warn(
        { err, provider: providerRow.provider },
        "Failed to check managed provider health",
      );
    }
  }

  const unhealthy = results.filter((r) => r.status !== "healthy");
  if (unhealthy.length > 0) {
    log.info(
      {
        total: results.length,
        unhealthy: unhealthy.length,
        providers: [...new Set(unhealthy.map((r) => r.provider))],
      },
      "Credential health check found issues",
    );
  } else {
    log.debug({ total: results.length }, "All credentials healthy");
  }

  return { checkedAt, results, unhealthy };
}

/**
 * Check credential health for a single provider. Returns the health
 * result for the most recent active connection, or null if no connection
 * exists.
 *
 * Checks BYO connections first; if none exist, falls back to checking
 * managed connections on the platform.
 *
 * Used by the watcher engine for pre-poll gating.
 */
export async function checkCredentialForProvider(
  provider: string,
): Promise<CredentialHealthResult | null> {
  let connections: OAuthConnectionRow[];
  try {
    connections = listActiveConnectionsByProvider(provider);
  } catch {
    connections = [];
  }

  if (connections.length > 0) {
    const conn = connections[0]!;
    const providerRow = getProvider(conn.provider);
    if (!providerRow) return null;

    return checkConnection({
      connectionId: conn.id,
      provider: conn.provider,
      accountInfo: conn.accountInfo,
      expiresAt: conn.expiresAt,
      hasRefreshToken: !!conn.hasRefreshToken,
      grantedScopesRaw: conn.grantedScopes,
      defaultScopesRaw: providerRow.defaultScopes,
      pingUrl: providerRow.pingUrl,
      pingMethod: providerRow.pingMethod,
      pingHeaders: providerRow.pingHeaders,
      pingBody: providerRow.pingBody,
    });
  }

  // No local connections — check if provider is managed and query the
  // platform for connection health.
  const providerRow = getProvider(provider);
  if (!providerRow) return null;
  if (!(await isManagedProvider(providerRow))) return null;

  const managedResults = await checkManagedProvider(providerRow);
  return managedResults.length > 0 ? managedResults[0] : null;
}
