/**
 * Proactive credential health monitoring.
 *
 * Enumerates all active OAuth connections and validates each one for:
 * - Token presence in secure storage
 * - Token expiry (expired or expiring within the warning window)
 * - Scope coverage (grantedScopes vs provider defaultScopes)
 * - Liveness ping (for providers with a pingUrl)
 *
 * Designed to run during the heartbeat cycle. The BYO liveness ping is
 * routed through `withValidToken`, so a stale-but-refreshable access token
 * is refreshed transparently before the ping fires — this prevents the
 * heartbeat from misreporting a refreshable connection as `"revoked"`.
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
import { scopeDifference } from "../oauth/scope-utils.js";
import {
  TokenExpiredError,
  withValidToken,
} from "../security/token-manager.js";
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

/**
 * Map a pingProvider result onto a CredentialHealthResult, or null when the
 * ping succeeded. `authErrorContext` distinguishes whether a 401/403 came
 * after a refresh attempt (refreshable connection) or directly from the
 * stored token (manual-token / no-refresh connection) — the latter is the
 * historical message wording.
 */
type PingFailureContext = "after_refresh" | "no_refresh";

function pingResultToHealthFailure(
  base: Omit<CredentialHealthResult, "status" | "details" | "canAutoRecover">,
  provider: string,
  connectionId: string,
  pingResult: { ok: boolean; authError: boolean },
  authErrorContext: PingFailureContext,
): CredentialHealthResult | null {
  if (pingResult.ok) return null;
  if (pingResult.authError) {
    const suffix =
      authErrorContext === "after_refresh" ? " after a refresh attempt" : "";
    return {
      ...base,
      status: "revoked",
      details: `${provider} token was rejected (401/403)${suffix}. The token may have been revoked. Re-authorization required.`,
      canAutoRecover: false,
    };
  }
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
  //
  // When the token is expired AND there is no refresh token, we have no path
  // to recovery — short-circuit to "expired". When there IS a refresh token,
  // we fall through so the ping (via withValidToken) can attempt a refresh
  // and confirm whether the refresh token still works. Without that, we'd
  // return "expiring" speculatively even when the refresh token was revoked.
  if (isTokenExpired(expiresAt) && !hasRefreshToken) {
    return {
      ...base,
      status: "expired",
      details: `Token for ${provider} is expired with no refresh token. Re-authorization required.`,
      canAutoRecover: false,
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
  //
  // For refreshable connections we route through withValidToken so an
  // expired-but-refreshable token gets refreshed before the ping fires.
  // Without this wrapping, the ping would hit 401 on a stale token and the
  // connection would be misreported as "revoked" — even though the next real
  // API call (which goes through BYOOAuthConnection.request → withValidToken)
  // would have refreshed and succeeded.
  if (pingUrl) {
    const runPing = (t: string) =>
      pingProvider(t, pingUrl, pingMethod, pingHeaders, pingBody);

    let pingResult: { ok: boolean; authError: boolean };
    let authContext: PingFailureContext;

    if (hasRefreshToken) {
      try {
        pingResult = await withValidToken(provider, runPing, { connectionId });
      } catch (err) {
        if (err instanceof TokenExpiredError) {
          // Refresh itself failed (revoked refresh token, invalid_grant, etc.)
          return {
            ...base,
            status: "revoked",
            details: `${provider} token refresh failed. The refresh token may have been revoked. Re-authorization required.`,
            canAutoRecover: false,
          };
        }
        throw err;
      }
      authContext = "after_refresh";
    } else {
      // Manual-token provider or an OAuth provider whose initial flow
      // didn't return a refresh_token — nothing to refresh, ping directly.
      pingResult = await runPing(token);
      authContext = "no_refresh";
    }

    const failure = pingResultToHealthFailure(
      base,
      provider,
      connectionId,
      pingResult,
      authContext,
    );
    if (failure) return failure;
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

    // Query without a status filter so we can distinguish "never
    // connected" (empty result) from "previously connected but now
    // inactive" (non-empty result with no ACTIVE entries).
    const params = new URLSearchParams();
    params.set("provider", providerRow.provider);

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
    const allConnections = (
      Array.isArray(body)
        ? body
        : ((body as Record<string, unknown>).results ?? [])
    ) as Array<{ id: string; account_label?: string; status?: string }>;

    if (allConnections.length === 0) {
      // No connections of any status — the user has never connected this
      // provider. The suggested-prompts system handles prompting them to
      // connect; this is not a health issue.
      return results;
    }

    const connections = allConnections.filter(
      (c) => (c.status ?? "ACTIVE").toUpperCase() === "ACTIVE",
    );

    if (connections.length === 0) {
      // Connections exist but none are active — the user previously
      // connected and the connection was revoked/deactivated.
      results.push({
        connectionId: `managed:${providerRow.provider}`,
        provider: providerRow.provider,
        accountInfo: allConnections[0]?.account_label ?? null,
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

        // Decompose the absolute pingUrl into base URL + relative path.
        // OAuthConnectionRequest.path is documented as relative, but
        // provider definitions store full absolute URLs.
        const parsedPingUrl = new URL(providerRow.pingUrl);
        const pingBaseUrl = `${parsedPingUrl.protocol}//${parsedPingUrl.host}`;
        const pingPath = parsedPingUrl.pathname + parsedPingUrl.search;

        const parsedHeaders = safeJsonParse<Record<string, string>>(
          providerRow.pingHeaders,
          {},
        );
        const parsedBody = safeJsonParse<unknown>(providerRow.pingBody, null);

        const pingResp = await platformConn.request({
          method: providerRow.pingMethod ?? "GET",
          path: pingPath,
          baseUrl: pingBaseUrl,
          ...(Object.keys(parsedHeaders).length > 0
            ? { headers: parsedHeaders }
            : {}),
          ...(parsedBody != null ? { body: parsedBody } : {}),
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
          // 401/403 from the upstream provider after the platform proxy
          // forwarded the request. From the daemon side we can't tell
          // whether the proxy attempted (and failed) a refresh-before-
          // forward or skipped refresh entirely and forwarded a stale token.
          // Either way it's not definitively unrecoverable — the next ping
          // cycle may succeed if the platform re-refreshes. Demote to
          // ping_failed so we don't fire a user-facing reconnect alert on
          // what may be a transient platform-side miss. Only platform-
          // attested 424 (CredentialRequiredError below) signals genuine
          // unrecoverable failure.
          log.debug(
            {
              provider: providerRow.provider,
              connectionId: conn.id,
              status: pingResp.status,
            },
            "Managed credential ping returned 401/403 — treating as potentially transient",
          );
          results.push({
            ...base,
            status: "ping_failed",
            details: `${providerRow.provider} managed liveness check returned ${pingResp.status} from the upstream provider. The Vellum platform may not have refreshed the token before forwarding; will retry next cycle.`,
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
        // CredentialRequiredError corresponds to a 424 from the platform
        // proxy — the platform attempted (and gave up on) refresh and is
        // telling us the credential is genuinely unrecoverable. This is
        // the only managed-path signal we trust enough to fire a user-
        // facing reconnect alert.
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          (err as { name: string }).name === "CredentialRequiredError"
        ) {
          results.push({
            ...base,
            status: "revoked",
            details: `${providerRow.provider} managed connection cannot be refreshed by the Vellum platform. Reconnect on the Vellum platform.`,
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

  // Check managed connections. If a provider is currently in managed mode,
  // evaluate it via the managed path even if stale BYO rows exist — the
  // user may have switched from BYO to managed.
  for (const providerRow of providers) {
    if (!(await isManagedProvider(providerRow))) continue;

    let managedResults: CredentialHealthResult[] = [];
    try {
      managedResults = await checkManagedProvider(providerRow);
    } catch (err) {
      log.warn(
        { err, provider: providerRow.provider },
        "Failed to check managed provider health",
      );
    }

    // Only replace BYO results with managed results when the managed
    // check returned something. If managed returned empty (user never
    // connected via managed mode), keep any existing BYO results.
    if (managedResults.length > 0 && byoProviders.has(providerRow.provider)) {
      const beforeLen = results.length;
      const filtered = results.filter(
        (r) => r.provider !== providerRow.provider,
      );
      if (filtered.length !== beforeLen) {
        results.length = 0;
        results.push(...filtered);
      }
    }
    results.push(...managedResults);
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
  const providerRow = getProvider(provider);
  if (!providerRow) return null;

  // Check managed mode first — if the provider is currently configured for
  // managed mode, evaluate via the platform regardless of stale BYO rows.
  if (await isManagedProvider(providerRow)) {
    const managedResults = await checkManagedProvider(providerRow);
    if (managedResults.length > 0) return managedResults[0]!;
    return null;
  }

  // Fall back to BYO (local) connection check.
  let connections: OAuthConnectionRow[];
  try {
    connections = listActiveConnectionsByProvider(provider);
  } catch {
    connections = [];
  }

  if (connections.length > 0) {
    const conn = connections[0]!;

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

  return null;
}
