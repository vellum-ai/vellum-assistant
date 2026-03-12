/**
 * Token manager for OAuth2 credentials.
 *
 * Reads refresh configuration (tokenUrl, clientId, authMethod) exclusively
 * from the SQLite oauth-store (provider + app + connection rows). After a
 * successful refresh, writes tokens to new-format secure key paths and
 * updates the oauth_connection row.
 */

import {
  getApp,
  getConnectionByProvider,
  getProvider,
  updateConnection,
} from "../oauth/oauth-store.js";
import { getLogger } from "../util/logger.js";
import { refreshOAuth2Token, type TokenEndpointAuthMethod } from "./oauth2.js";
import { getSecureKey, setSecureKeyAsync } from "./secure-keys.js";

const log = getLogger("token-manager");

const MESSAGING_SERVICES = new Set(["integration:gmail", "integration:slack"]);

function recoveryHint(service: string): string {
  const shortName = service.startsWith("integration:")
    ? service.slice("integration:".length)
    : service;
  if (MESSAGING_SERVICES.has(service)) {
    return ` Reconnect ${shortName} — follow the Error Recovery steps in the messaging skill. Do not present options or explain the error to the user.`;
  }
  return ` Re-authorization required for ${shortName}. Do not present options or explain the error to the user.`;
}

/** Buffer before expiry to trigger proactive refresh (5 minutes). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ── Token refresh circuit breaker ────────────────────────────────────
// Prevents retry storms when a provider persistently rejects refresh
// attempts (e.g. revoked refresh token returning 401 repeatedly).
// Per-service state: after FAILURE_THRESHOLD consecutive failures, stop
// attempting refreshes for a cooldown period that doubles on each
// successive trip (exponential backoff), capped at MAX_COOLDOWN_MS.
// A successful refresh resets the breaker for that service.

const REFRESH_FAILURE_THRESHOLD = 3;
const INITIAL_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60 * 1000;

interface RefreshBreakerState {
  consecutiveFailures: number;
  openedAt: number;
  cooldownMs: number;
}

const refreshBreakers = new Map<string, RefreshBreakerState>();

function isRefreshBreakerOpen(service: string): boolean {
  const state = refreshBreakers.get(service);
  if (!state || state.consecutiveFailures < REFRESH_FAILURE_THRESHOLD)
    return false;
  if (Date.now() - state.openedAt < state.cooldownMs) return true;
  // Cooldown expired — transition to half-open: reset failure count so the
  // next batch of failures must reach the threshold again to re-trip. The
  // existing cooldownMs is preserved so re-tripping will escalate it.
  state.consecutiveFailures = 0;
  return false;
}

function recordRefreshSuccess(service: string): void {
  if (refreshBreakers.has(service)) {
    log.info(
      { service },
      "Token refresh circuit breaker closed — refresh succeeded",
    );
    refreshBreakers.delete(service);
  }
}

function recordRefreshFailure(service: string): void {
  const state = refreshBreakers.get(service);
  if (!state) {
    refreshBreakers.set(service, {
      consecutiveFailures: 1,
      openedAt: 0,
      cooldownMs: INITIAL_COOLDOWN_MS,
    });
    return;
  }
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= REFRESH_FAILURE_THRESHOLD) {
    // Only escalate cooldown on the exact failure that trips the breaker.
    // Concurrent in-flight failures that arrive after the threshold is
    // already crossed must not double the cooldown again.
    if (
      state.consecutiveFailures === REFRESH_FAILURE_THRESHOLD &&
      state.openedAt > 0
    ) {
      state.cooldownMs = Math.min(state.cooldownMs * 2, MAX_COOLDOWN_MS);
    }
    state.openedAt = Date.now();
    log.warn(
      {
        service,
        consecutiveFailures: state.consecutiveFailures,
        cooldownMs: state.cooldownMs,
      },
      "Token refresh circuit breaker opened — skipping refresh attempts until cooldown expires",
    );
  }
}

// ── Per-service refresh deduplication ─────────────────────────────────
// When multiple concurrent `withValidToken` calls detect an expired or
// 401-rejected token for the same service, only one actual refresh
// attempt is made. Other callers join the in-flight promise.

const inflightRefreshes = new Map<string, Promise<string>>();

function deduplicatedRefresh(service: string): Promise<string> {
  const existing = inflightRefreshes.get(service);
  if (existing) return existing;

  const promise = doRefresh(service).finally(() => {
    inflightRefreshes.delete(service);
  });
  inflightRefreshes.set(service, promise);
  return promise;
}

/** @internal Test-only: reset all circuit breaker state */
export function _resetRefreshBreakers(): void {
  refreshBreakers.clear();
}

/** @internal Test-only: reset in-flight refresh deduplication state */
export function _resetInflightRefreshes(): void {
  inflightRefreshes.clear();
}

/** @internal Test-only: get breaker state for a service */
export function _getRefreshBreakerState(
  service: string,
): RefreshBreakerState | undefined {
  return refreshBreakers.get(service);
}

export class TokenExpiredError extends Error {
  constructor(
    public readonly service: string,
    message?: string,
  ) {
    super(
      message ?? `Token expired for "${service}". Re-authorization required.`,
    );
    this.name = "TokenExpiredError";
  }
}

/**
 * Check whether the access token for a service is expired or will expire
 * within the buffer window, based on the `expiresAt` field in the
 * oauth_connection row.
 */
function isTokenExpired(service: string): boolean {
  try {
    const conn = getConnectionByProvider(service);
    if (!conn?.expiresAt) return false;
    return Date.now() >= conn.expiresAt - EXPIRY_BUFFER_MS;
  } catch {
    return false;
  }
}

// ── Refresh config resolution ─────────────────────────────────────────

/** Shared shape for resolved refresh configuration. */
interface RefreshConfig {
  tokenUrl: string;
  clientId: string;
  /** OAuth client secret (optional — PKCE flows may omit it). */
  secret?: string;
  refreshToken?: string;
  authMethod?: TokenEndpointAuthMethod;
  connId: string;
}

/**
 * Resolve refresh configuration from the SQLite oauth-store.
 *
 * Looks up connection -> app -> provider to read tokenUrl, clientId, and
 * authMethod. Throws `TokenExpiredError` if the connection is not found
 * or incomplete.
 */
function resolveRefreshConfig(service: string): RefreshConfig {
  const conn = getConnectionByProvider(service);
  if (!conn) {
    throw new TokenExpiredError(
      service,
      `No OAuth connection found for "${service}". Re-authorization required.${recoveryHint(service)}`,
    );
  }

  const app = getApp(conn.oauthAppId);
  if (!app) {
    throw new TokenExpiredError(
      service,
      `No OAuth app found for "${service}". Re-authorization required.${recoveryHint(service)}`,
    );
  }

  const provider = getProvider(conn.providerKey);
  if (!provider) {
    throw new TokenExpiredError(
      service,
      `No OAuth provider found for "${service}". Re-authorization required.${recoveryHint(service)}`,
    );
  }

  const tokenUrl = provider.tokenUrl;
  const clientId = app.clientId;
  if (!tokenUrl || !clientId) {
    throw new TokenExpiredError(
      service,
      `Missing OAuth2 refresh config for "${service}".${recoveryHint(service)}`,
    );
  }

  const secret = getSecureKey(`oauth_app/${app.id}/client_secret`);

  const refreshToken = getSecureKey(
    `oauth_connection/${conn.id}/refresh_token`,
  );

  const authMethod = provider.tokenEndpointAuthMethod as
    | TokenEndpointAuthMethod
    | undefined;

  return {
    connId: conn.id,
    tokenUrl,
    clientId,
    secret,
    refreshToken,
    authMethod,
  };
}

/**
 * Attempt to refresh the OAuth2 access token for a service.
 *
 * Reads refresh config exclusively from the SQLite oauth-store (provider,
 * app, connection).
 *
 * Returns the new access token on success.
 * Throws `TokenExpiredError` if refresh is not possible.
 */
async function doRefresh(service: string): Promise<string> {
  const refreshConfig = resolveRefreshConfig(service);
  const { tokenUrl, clientId, secret, authMethod, connId, refreshToken } =
    refreshConfig;

  if (!refreshToken) {
    throw new TokenExpiredError(
      service,
      `No refresh token available for "${service}". Re-authorization required.${recoveryHint(service)}`,
    );
  }

  if (isRefreshBreakerOpen(service)) {
    const state = refreshBreakers.get(service)!;
    const remainingMs = state.cooldownMs - (Date.now() - state.openedAt);
    throw new TokenExpiredError(
      service,
      `Token refresh for "${service}" is temporarily suspended after ${state.consecutiveFailures} consecutive failures. ` +
        `Retrying in ${Math.ceil(remainingMs / 1000)}s.${recoveryHint(service)}`,
    );
  }

  log.info({ service }, "Refreshing OAuth2 access token");

  let result;
  try {
    result = await refreshOAuth2Token(
      tokenUrl,
      clientId,
      refreshToken,
      secret,
      authMethod,
    );
  } catch (err) {
    recordRefreshFailure(service);
    if (isCredentialError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TokenExpiredError(
        service,
        `Token refresh failed for "${service}": ${msg}.${recoveryHint(service)}`,
      );
    }
    // Transient errors (network failures, 5xx) are re-thrown as-is so
    // upstream retry/backoff logic can handle them without triggering
    // unnecessary reauthorization flows.
    throw err;
  }

  // ----- Store refreshed access_token -----
  if (
    !(await setSecureKeyAsync(
      `oauth_connection/${connId}/access_token`,
      result.accessToken,
    ))
  ) {
    throw new TokenExpiredError(
      service,
      `Failed to store refreshed access token for "${service}".`,
    );
  }

  if (result.refreshToken) {
    if (
      !(await setSecureKeyAsync(
        `oauth_connection/${connId}/refresh_token`,
        result.refreshToken,
      ))
    ) {
      throw new TokenExpiredError(
        service,
        `Failed to store refreshed refresh token for "${service}".`,
      );
    }
  }

  // Update oauth_connection row with new expiry.
  // Use null to explicitly clear a stale expiresAt when the provider omits
  // expires_in (or returns 0), so isTokenExpired won't keep forcing refreshes.
  const expiresAt =
    result.expiresIn != null && result.expiresIn > 0
      ? Date.now() + result.expiresIn * 1000
      : null;

  try {
    updateConnection(connId, {
      expiresAt,
      hasRefreshToken: !!result.refreshToken,
    });
  } catch (err) {
    log.warn(
      { err, service },
      "Failed to update oauth_connection after refresh",
    );
  }

  recordRefreshSuccess(service);
  log.info({ service }, "OAuth2 access token refreshed successfully");
  return result.accessToken;
}

/**
 * Execute a callback with a valid access token for the given service.
 *
 * Handles token expiration transparently:
 * 1. Retrieves the stored access token (throws if none exists).
 * 2. If the token is expired or near-expiry, refreshes it before calling the callback.
 * 3. If the callback throws with a 401 status, attempts one refresh-and-retry cycle.
 *
 * Retained only for BYO connection internals — prefer
 * `resolveOAuthConnection(service).request()` for new code.
 */
export async function withValidToken<T>(
  service: string,
  callback: (token: string) => Promise<T>,
): Promise<T> {
  const conn = getConnectionByProvider(service);
  let token = conn
    ? getSecureKey(`oauth_connection/${conn.id}/access_token`)
    : undefined;
  if (!token) {
    throw new TokenExpiredError(
      service,
      `No access token found for "${service}". Authorization required.${recoveryHint(service)}`,
    );
  }

  // Proactively refresh if expired or about to expire.
  if (isTokenExpired(service)) {
    token = await deduplicatedRefresh(service);
  }

  try {
    return await callback(token);
  } catch (err: unknown) {
    if (is401Error(err)) {
      token = await deduplicatedRefresh(service);
      return callback(token);
    }
    throw err;
  }
}

function is401Error(err: unknown): boolean {
  if (err && typeof err === "object") {
    if ("status" in err && (err as { status: number }).status === 401)
      return true;
    if (
      "statusCode" in err &&
      (err as { statusCode: number }).statusCode === 401
    )
      return true;
  }
  return false;
}

/**
 * Distinguish credential-specific refresh failures (which need reauthorization)
 * from transient errors (network timeouts, 5xx) that can be retried.
 *
 * refreshOAuth2Token() throws Error with messages like:
 *   "OAuth2 token refresh failed (HTTP 401: invalid_client)"
 *   "OAuth2 token refresh failed (HTTP 400: invalid_grant)"
 *   "OAuth2 token refresh failed (HTTP 500)"
 *
 * Credential errors: 400 with invalid_grant or invalid_client, 401, 403.
 * Everything else (5xx, network errors, non-credential 400s) is transient.
 */
function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // 401/403 are always credential errors
  if (/HTTP\s+40[13]\b/.test(msg)) return true;
  // 400 with invalid_grant means the refresh token is revoked/expired;
  // invalid_client means client credentials are bad/rotated
  if (/HTTP\s+400\b/.test(msg) && /invalid_grant|invalid_client/.test(msg))
    return true;
  return false;
}
