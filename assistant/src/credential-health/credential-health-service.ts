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

import {
  isTokenExpired,
  oauthConnectionAccessTokenPath,
} from "@vellumai/credential-storage";

import {
  getProvider,
  listActiveConnectionsByProvider,
  listProviders,
} from "../oauth/oauth-store.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
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
export let _fetchFn: typeof fetch = fetch;

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

  // 1. Check token presence
  const token = await getSecureKeyAsync(
    oauthConnectionAccessTokenPath(connectionId),
  );
  if (!token) {
    return {
      ...base,
      status: "missing_token",
      details: `No access token found for ${provider}. Re-authorization required.`,
      canAutoRecover: false,
    };
  }

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

// ── Public API ────────────────────────────────────────────────────────

/**
 * Check the health of all active OAuth connections.
 *
 * Iterates every registered provider, looks up active connections, and
 * validates each one. Returns a structured report with overall results
 * and a filtered list of unhealthy credentials.
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
 * Used by the watcher engine for pre-poll gating.
 */
export async function checkCredentialForProvider(
  provider: string,
): Promise<CredentialHealthResult | null> {
  let connections;
  try {
    connections = listActiveConnectionsByProvider(provider);
  } catch {
    return null;
  }
  if (connections.length === 0) return null;

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
