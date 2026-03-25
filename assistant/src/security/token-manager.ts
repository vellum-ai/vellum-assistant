/**
 * Token manager for OAuth2 credentials.
 *
 * Reads refresh configuration (tokenUrl, clientId, authMethod) exclusively
 * from the SQLite oauth-store (provider + app + connection rows). After a
 * successful refresh, writes tokens to new-format secure key paths and
 * updates the oauth_connection row.
 *
 * Token expiry checking, circuit breaker, refresh deduplication, and
 * credential error classification are delegated to the shared
 * `@vellumai/credential-storage` package.
 */

import {
  isCredentialError,
  isTokenExpired,
  oauthConnectionAccessTokenPath,
  oauthConnectionRefreshTokenPath,
  persistRefreshedTokens,
  RefreshCircuitBreaker,
  RefreshDeduplicator,
  type SecureKeyBackend,
} from "@vellumai/credential-storage";

import {
  getApp,
  getConnection,
  getConnectionByProvider,
  getProvider,
  updateConnection,
} from "../oauth/oauth-store.js";
import { getLogger } from "../util/logger.js";
import { refreshOAuth2Token, type TokenEndpointAuthMethod } from "./oauth2.js";
import { getSecureKeyAsync, setSecureKeyAsync } from "./secure-keys.js";

const log = getLogger("token-manager");

const MESSAGING_SERVICES = new Set(["google", "slack"]);

function recoveryHint(service: string): string {
  if (MESSAGING_SERVICES.has(service)) {
    return ` Reconnect ${service} — follow the Error Recovery steps in the messaging skill. Do not present options or explain the error to the user.`;
  }
  return ` Re-authorization required for ${service}. Do not present options or explain the error to the user.`;
}

// ── Shared circuit breaker & deduplication instances ──────────────────
// Backed by the portable primitives from @vellumai/credential-storage.

const circuitBreaker = new RefreshCircuitBreaker();
const refreshDeduplicator = new RefreshDeduplicator();

/** @internal Test-only: reset all circuit breaker state */
export function _resetRefreshBreakers(): void {
  circuitBreaker.clear();
}

/** @internal Test-only: reset in-flight refresh deduplication state */
export function _resetInflightRefreshes(): void {
  refreshDeduplicator.clear();
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

// ── Secure-key backend adapter ────────────────────────────────────────
// Wraps the assistant's secure-key functions into the SecureKeyBackend
// interface expected by @vellumai/credential-storage helpers.

const secureKeyBackend: SecureKeyBackend = {
  get: (key: string) => getSecureKeyAsync(key),
  set: (key: string, value: string) => setSecureKeyAsync(key, value),
  delete: async () => {
    // Not needed in this module — refresh persistence only writes tokens.
    return "not-found";
  },
  list: async () => [],
};

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
async function resolveRefreshConfig(
  service: string,
  connId: string,
): Promise<RefreshConfig> {
  const conn = getConnection(connId);
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
  const resolvedClientId = app.clientId;
  if (!tokenUrl || !resolvedClientId) {
    throw new TokenExpiredError(
      service,
      `Missing OAuth2 refresh config for "${service}".${recoveryHint(service)}`,
    );
  }

  const secret = await getSecureKeyAsync(app.clientSecretCredentialPath);

  const refreshToken = await getSecureKeyAsync(
    oauthConnectionRefreshTokenPath(conn.id),
  );

  const authMethod = provider.tokenEndpointAuthMethod as
    | TokenEndpointAuthMethod
    | undefined;

  return {
    connId: conn.id,
    tokenUrl,
    clientId: resolvedClientId,
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
async function doRefresh(service: string, connId: string): Promise<string> {
  const refreshConfig = await resolveRefreshConfig(service, connId);
  const {
    tokenUrl,
    clientId: resolvedClientId,
    secret,
    authMethod,
    refreshToken,
  } = refreshConfig;

  if (!refreshToken) {
    throw new TokenExpiredError(
      service,
      `No refresh token available for "${service}". Re-authorization required.${recoveryHint(service)}`,
    );
  }

  if (circuitBreaker.isOpen(connId)) {
    const state = circuitBreaker.getState(connId)!;
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
      resolvedClientId,
      refreshToken,
      secret,
      authMethod,
    );
  } catch (err) {
    circuitBreaker.recordFailure(connId);
    if (circuitBreaker.isOpen(connId)) {
      const state = circuitBreaker.getState(connId)!;
      log.warn(
        {
          service,
          consecutiveFailures: state.consecutiveFailures,
          cooldownMs: state.cooldownMs,
        },
        "Token refresh circuit breaker opened — skipping refresh attempts until cooldown expires",
      );
    }
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

  // ----- Persist refreshed tokens via shared helper -----
  let persisted;
  try {
    persisted = await persistRefreshedTokens(secureKeyBackend, connId, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TokenExpiredError(
      service,
      `Failed to store refreshed access token for "${service}": ${msg}`,
    );
  }

  // Update oauth_connection row with new expiry.
  try {
    updateConnection(connId, {
      expiresAt: persisted.expiresAt,
      hasRefreshToken: persisted.hasRefreshToken,
    });
  } catch (err) {
    log.warn(
      { err, service },
      "Failed to update oauth_connection after refresh",
    );
  }

  circuitBreaker.recordSuccess(connId);
  log.info({ service }, "OAuth2 access token refreshed successfully");
  return persisted.accessToken;
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
  opts?: string | { connectionId: string },
): Promise<T> {
  const conn =
    opts && typeof opts === "object"
      ? getConnection(opts.connectionId)
      : getConnectionByProvider(service, opts);
  let token = conn
    ? await getSecureKeyAsync(oauthConnectionAccessTokenPath(conn.id))
    : undefined;
  if (!token || !conn) {
    throw new TokenExpiredError(
      service,
      `No access token found for "${service}". Authorization required.${recoveryHint(service)}`,
    );
  }

  // Proactively refresh if expired or about to expire.
  if (isTokenExpired(conn.expiresAt)) {
    token = await refreshDeduplicator.deduplicate(conn.id, () =>
      doRefresh(service, conn.id),
    );
  }

  try {
    return await callback(token);
  } catch (err: unknown) {
    if (is401Error(err)) {
      token = await refreshDeduplicator.deduplicate(conn.id, () =>
        doRefresh(service, conn.id),
      );
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
