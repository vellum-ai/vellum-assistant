/**
 * OAuth connection persistence, token persistence, and refresh support
 * primitives.
 *
 * This module provides portable, backend-agnostic helpers for:
 * - Secure-key path conventions for OAuth tokens and client secrets
 * - Token expiry checking with proactive refresh buffering
 * - Token refresh circuit breaker to prevent retry storms
 * - Per-connection refresh deduplication
 * - Abstract token persistence interface
 *
 * It has NO dependency on the assistant daemon, SQLite, Drizzle, or any
 * service-specific module. The assistant's token-manager.ts and
 * token-persistence.ts wire in the platform-specific backends and
 * delegate here for shared logic.
 */

import type { SecureKeyBackend } from "./index.js";

// ---------------------------------------------------------------------------
// Secure-key path conventions
// ---------------------------------------------------------------------------

/**
 * Build the secure-key path for an OAuth connection's access token.
 */
export function oauthConnectionAccessTokenPath(connectionId: string): string {
  return `oauth_connection/${connectionId}/access_token`;
}

/**
 * Build the secure-key path for an OAuth connection's refresh token.
 */
export function oauthConnectionRefreshTokenPath(connectionId: string): string {
  return `oauth_connection/${connectionId}/refresh_token`;
}

/**
 * Build the secure-key path for an OAuth app's client secret.
 */
export function oauthAppClientSecretPath(appId: string): string {
  return `oauth_app/${appId}/client_secret`;
}

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------

/** Buffer before expiry to trigger proactive refresh (5 minutes). */
export const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Check whether a token is expired or will expire within the buffer window.
 */
export function isTokenExpired(
  expiresAt: number | null,
  bufferMs: number = EXPIRY_BUFFER_MS
): boolean {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt - bufferMs;
}

/**
 * Compute the absolute expiry timestamp from an `expires_in` seconds value.
 * Returns null if the value is missing or zero.
 */
export function computeExpiresAt(
  expiresIn: number | null | undefined
): number | null {
  if (expiresIn == null || expiresIn <= 0) return null;
  return Date.now() + expiresIn * 1000;
}

// ---------------------------------------------------------------------------
// Token refresh circuit breaker
// ---------------------------------------------------------------------------
// Prevents retry storms when a provider persistently rejects refresh
// attempts (e.g. revoked refresh token returning 401 repeatedly).
// Per-key state: after FAILURE_THRESHOLD consecutive failures, stop
// attempting refreshes for a cooldown period that doubles on each
// successive trip (exponential backoff), capped at MAX_COOLDOWN_MS.
// A successful refresh resets the breaker for that key.

export const REFRESH_FAILURE_THRESHOLD = 3;
export const INITIAL_COOLDOWN_MS = 30_000;
export const MAX_COOLDOWN_MS = 10 * 60 * 1000;

export interface RefreshBreakerState {
  consecutiveFailures: number;
  openedAt: number;
  cooldownMs: number;
  /** Whether the breaker tripped due to a credential error (vs transient). */
  isCredentialError: boolean;
}

/**
 * In-memory token refresh circuit breaker.
 *
 * Tracks per-key (typically connection ID) failure state. After
 * FAILURE_THRESHOLD consecutive failures, the breaker opens for a
 * cooldown period that doubles on each successive trip.
 */
export class RefreshCircuitBreaker {
  private breakers = new Map<string, RefreshBreakerState>();

  /**
   * Check whether the breaker is currently open (refusing refresh attempts)
   * for the given key. If the cooldown has expired, transitions to half-open
   * by resetting the failure count.
   */
  isOpen(key: string): boolean {
    const state = this.breakers.get(key);
    if (!state || state.consecutiveFailures < REFRESH_FAILURE_THRESHOLD)
      return false;
    if (Date.now() - state.openedAt < state.cooldownMs) return true;
    // Cooldown expired — transition to half-open: reset failure count so the
    // next batch of failures must reach the threshold again to re-trip. The
    // existing cooldownMs is preserved so re-tripping will escalate it.
    state.consecutiveFailures = 0;
    return false;
  }

  /** Get the breaker state for a key, if it exists. */
  getState(key: string): RefreshBreakerState | undefined {
    return this.breakers.get(key);
  }

  /** Record a successful refresh, resetting the breaker for the key. */
  recordSuccess(key: string): void {
    this.breakers.delete(key);
  }

  /**
   * Record a failed refresh attempt, potentially opening the breaker.
   *
   * @param isCredential - When true, the failure is a credential error
   *   (revoked token, invalid client) that no amount of retrying will fix.
   *   Only credential errors count toward opening the circuit breaker.
   *   Transient errors (network timeouts, 5xx) are recorded for diagnostics
   *   but do not trip the breaker — they are handled by upstream retry logic.
   */
  recordFailure(key: string, isCredential = true): void {
    if (!isCredential) {
      // Transient failures should not trip the breaker. The retry logic in
      // refreshOAuth2Token handles transient errors with its own backoff.
      return;
    }
    const state = this.breakers.get(key);
    if (!state) {
      this.breakers.set(key, {
        consecutiveFailures: 1,
        openedAt: 0,
        cooldownMs: INITIAL_COOLDOWN_MS,
        isCredentialError: true,
      });
      return;
    }
    state.consecutiveFailures++;
    state.isCredentialError = true;
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
    }
  }

  /** Reset all breaker state (primarily for testing). */
  clear(): void {
    this.breakers.clear();
  }
}

// ---------------------------------------------------------------------------
// Refresh deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicates concurrent refresh attempts for the same key.
 *
 * When multiple callers detect an expired or rejected token for the same
 * connection simultaneously, only one actual refresh attempt is made.
 * Other callers join the in-flight promise.
 */
export class RefreshDeduplicator {
  private inflight = new Map<string, Promise<string>>();

  /**
   * Execute a refresh operation, deduplicating concurrent calls for the same key.
   * If a refresh is already in flight for the given key, returns the existing promise.
   */
  deduplicate(key: string, refreshFn: () => Promise<string>): Promise<string> {
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = refreshFn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /** Reset all in-flight state (primarily for testing). */
  clear(): void {
    this.inflight.clear();
  }
}

// ---------------------------------------------------------------------------
// Credential error classification
// ---------------------------------------------------------------------------

/**
 * Distinguish credential-specific refresh failures (which need reauthorization)
 * from transient errors (network timeouts, 5xx) that can be retried.
 *
 * Credential errors: 400 with invalid_grant or invalid_client, 401, 403.
 * Everything else (5xx, network errors, non-credential 400s) is transient.
 */
export function isCredentialError(err: unknown): boolean {
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

// ---------------------------------------------------------------------------
// Token persistence helpers
// ---------------------------------------------------------------------------

/**
 * Persist an OAuth access token (and optionally a refresh token) to the
 * secure-key backend for a given connection ID.
 *
 * When `refreshToken` is provided, it is stored. When omitted (undefined),
 * any existing refresh token is cleared to prevent stale token usage.
 */
export async function persistOAuthTokens(
  backend: SecureKeyBackend,
  connectionId: string,
  tokens: {
    accessToken: string;
    refreshToken?: string;
  }
): Promise<void> {
  const accessPath = oauthConnectionAccessTokenPath(connectionId);
  const stored = await backend.set(accessPath, tokens.accessToken);
  if (!stored) {
    throw new Error("Failed to store access token in secure storage");
  }

  const refreshPath = oauthConnectionRefreshTokenPath(connectionId);
  if (tokens.refreshToken) {
    await backend.set(refreshPath, tokens.refreshToken);
  } else {
    // Re-auth grants that omit refresh_token must clear any stale stored
    // token — otherwise refresh attempts will use invalid credentials.
    await backend.delete(refreshPath);
  }
}

/**
 * Retrieve the stored access token for a connection from the secure-key backend.
 * Returns undefined if no token is stored.
 */
export async function getStoredAccessToken(
  backend: SecureKeyBackend,
  connectionId: string
): Promise<string | undefined> {
  return backend.get(oauthConnectionAccessTokenPath(connectionId));
}

/**
 * Retrieve the stored refresh token for a connection from the secure-key backend.
 * Returns undefined if no token is stored.
 */
export async function getStoredRefreshToken(
  backend: SecureKeyBackend,
  connectionId: string
): Promise<string | undefined> {
  return backend.get(oauthConnectionRefreshTokenPath(connectionId));
}

/**
 * Delete all OAuth tokens (access + refresh) for a connection from the
 * secure-key backend. Returns the individual deletion results.
 */
export async function deleteOAuthTokens(
  backend: SecureKeyBackend,
  connectionId: string
): Promise<{
  accessTokenResult: "deleted" | "not-found" | "error";
  refreshTokenResult: "deleted" | "not-found" | "error";
}> {
  // Delete sequentially to avoid lost updates — the encrypted store uses
  // read-modify-write, so concurrent deletes can restore a deleted key.
  const accessTokenResult = await backend.delete(oauthConnectionAccessTokenPath(connectionId));
  const refreshTokenResult = await backend.delete(oauthConnectionRefreshTokenPath(connectionId));
  return { accessTokenResult, refreshTokenResult };
}

/**
 * Store a refreshed access token in the secure-key backend and update
 * connection metadata. Returns the new access token on success.
 *
 * This is the portable portion of the post-refresh persistence logic.
 * Callers are responsible for updating their connection store (e.g. SQLite)
 * with the new expiresAt and hasRefreshToken values.
 */
export async function persistRefreshedTokens(
  backend: SecureKeyBackend,
  connectionId: string,
  result: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number | null;
  }
): Promise<{
  accessToken: string;
  expiresAt: number | null;
  hasRefreshToken: boolean;
}> {
  const accessPath = oauthConnectionAccessTokenPath(connectionId);
  if (!(await backend.set(accessPath, result.accessToken))) {
    throw new Error(
      `Failed to store refreshed access token for connection ${connectionId}`
    );
  }

  if (result.refreshToken) {
    const refreshPath = oauthConnectionRefreshTokenPath(connectionId);
    if (!(await backend.set(refreshPath, result.refreshToken))) {
      throw new Error(
        `Failed to store refreshed refresh token for connection ${connectionId}`
      );
    }
  }

  const expiresAt = computeExpiresAt(result.expiresIn);

  return {
    accessToken: result.accessToken,
    expiresAt,
    hasRefreshToken: !!result.refreshToken,
  };
}
