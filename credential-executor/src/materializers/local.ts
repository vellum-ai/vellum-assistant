/**
 * CES local credential materialisation.
 *
 * Materialises credential values from local storage into per-operation
 * results that the CES execution layer can inject into authenticated
 * requests or commands. Materialised values never persist to assistant-
 * visible state — they exist only for the duration of the execution.
 *
 * Supports two credential types:
 *
 * - **Static secrets** — Retrieved from the secure-key backend using the
 *   storage key from the resolved subject. Fails if the key is missing.
 *
 * - **OAuth tokens** — Retrieved from the secure-key backend using the
 *   connection's access token path. Automatically refreshes expired tokens
 *   using the shared `@vellumai/credential-storage` refresh primitives.
 *   Fails if no access token exists (disconnected connection) or if
 *   refresh fails.
 *
 * Materialisation is fail-closed: missing keys, disconnected connections,
 * and refresh failures all return errors before any outbound work starts.
 */

import {
  type SecureKeyBackend,
  type TokenRefreshResult,
  getStoredAccessToken,
  getStoredRefreshToken,
  isTokenExpired,
  RefreshCircuitBreaker,
  RefreshDeduplicator,
  persistRefreshedTokens,
} from "@vellumai/credential-storage";
import { HandleType } from "@vellumai/ces-contracts";

import type {
  ResolvedLocalSubject,
  ResolvedOAuthSubject,
  ResolvedStaticSubject,
} from "../subjects/local.js";

// ---------------------------------------------------------------------------
// Materialisation result
// ---------------------------------------------------------------------------

/**
 * A materialised credential value ready for injection into an execution
 * environment. The value is ephemeral and must not be persisted to any
 * assistant-visible store.
 */
export interface MaterialisedCredential {
  /** The credential value (secret, token, etc.). */
  value: string;
  /** The handle type that produced this value. */
  handleType: HandleType;
  /** For OAuth: the token expiry timestamp (null if unknown). */
  expiresAt?: number | null;
}

export type MaterialisationResult =
  | { ok: true; credential: MaterialisedCredential }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Token refresh callback
// ---------------------------------------------------------------------------

/**
 * Callback for performing the actual OAuth token refresh network call.
 *
 * CES delegates the refresh network call to callers so it remains
 * transport-agnostic. The callback receives the connection ID and
 * refresh token, and returns a `TokenRefreshResult` from the shared
 * credential-storage primitives.
 */
export type TokenRefreshFn = (
  connectionId: string,
  refreshToken: string,
) => Promise<TokenRefreshResult>;

// ---------------------------------------------------------------------------
// Local materialiser
// ---------------------------------------------------------------------------

export interface LocalMaterialiserDeps {
  /** Secure-key backend for retrieving secret values. */
  secureKeyBackend: SecureKeyBackend;
  /** Optional token refresh callback for OAuth tokens. */
  tokenRefreshFn?: TokenRefreshFn;
}

/**
 * Local credential materialiser.
 *
 * Stateful: maintains a per-connection circuit breaker and refresh
 * deduplicator for OAuth token refresh. Create one instance per CES
 * process lifetime.
 */
export class LocalMaterialiser {
  private readonly backend: SecureKeyBackend;
  private readonly tokenRefreshFn?: TokenRefreshFn;
  private readonly circuitBreaker = new RefreshCircuitBreaker();
  private readonly deduplicator = new RefreshDeduplicator();

  constructor(deps: LocalMaterialiserDeps) {
    this.backend = deps.secureKeyBackend;
    this.tokenRefreshFn = deps.tokenRefreshFn;
  }

  /**
   * Materialise a resolved local subject into a credential value.
   *
   * Dispatches to the appropriate handler based on the subject type.
   * Returns a discriminated result — never throws for expected failure
   * modes (missing keys, disconnected connections, expired tokens).
   */
  async materialise(
    subject: ResolvedLocalSubject,
  ): Promise<MaterialisationResult> {
    switch (subject.type) {
      case HandleType.LocalStatic:
        return this.materialiseStatic(subject);
      case HandleType.LocalOAuth:
        return this.materialiseOAuth(subject);
      default:
        return {
          ok: false,
          error: `Unsupported subject type for local materialisation`,
        };
    }
  }

  // -----------------------------------------------------------------------
  // Static secret materialisation
  // -----------------------------------------------------------------------

  private async materialiseStatic(
    subject: ResolvedStaticSubject,
  ): Promise<MaterialisationResult> {
    const secretValue = await this.backend.get(subject.storageKey);
    if (secretValue === undefined) {
      return {
        ok: false,
        error: `Secure key "${subject.storageKey}" not found in local credential store. ` +
          `The credential for service="${subject.metadata.service}", field="${subject.metadata.field}" ` +
          `has metadata but no secret value stored.`,
      };
    }

    return {
      ok: true,
      credential: {
        value: secretValue,
        handleType: HandleType.LocalStatic,
      },
    };
  }

  // -----------------------------------------------------------------------
  // OAuth token materialisation
  // -----------------------------------------------------------------------

  private async materialiseOAuth(
    subject: ResolvedOAuthSubject,
  ): Promise<MaterialisationResult> {
    const { connection } = subject;
    const connectionId = connection.id;

    // 1. Get the stored access token
    const accessToken = await getStoredAccessToken(
      this.backend,
      connectionId,
    );

    if (!accessToken) {
      return {
        ok: false,
        error: `No access token found for OAuth connection "${connectionId}" ` +
          `(provider="${connection.providerKey}"). The connection is disconnected.`,
      };
    }

    // 2. Check if the token is expired and needs refresh
    if (connection.hasRefreshToken) {
      // For refreshable tokens, use the proactive buffer so we can refresh
      // before the token actually expires.
      if (isTokenExpired(connection.expiresAt)) {
        return this.refreshAndMaterialise(subject, connectionId);
      }
    } else {
      // For non-refreshable tokens, check against the hard expiry — use
      // every valid second rather than the 5-minute proactive buffer.
      if (connection.expiresAt && Date.now() >= connection.expiresAt) {
        return {
          ok: false,
          error: `Token for OAuth connection "${connectionId}" is expired and no refresh ` +
            `token is available. Re-authorization required.`,
        };
      }
    }

    // 3. Token is valid — return it
    return {
      ok: true,
      credential: {
        value: accessToken,
        handleType: HandleType.LocalOAuth,
        expiresAt: connection.expiresAt,
      },
    };
  }

  /**
   * Refresh an expired OAuth token and return the materialised result.
   *
   * Uses the circuit breaker to prevent retry storms and the deduplicator
   * to coalesce concurrent refresh attempts for the same connection.
   */
  private async refreshAndMaterialise(
    subject: ResolvedOAuthSubject,
    connectionId: string,
  ): Promise<MaterialisationResult> {
    // Check circuit breaker
    if (this.circuitBreaker.isOpen(connectionId)) {
      return {
        ok: false,
        error: `Token refresh circuit breaker is open for connection "${connectionId}". ` +
          `Too many consecutive refresh failures. Re-authorization may be required.`,
      };
    }

    if (!this.tokenRefreshFn) {
      return {
        ok: false,
        error: `Token for OAuth connection "${connectionId}" is expired but no refresh ` +
          `function is configured. Re-authorization required.`,
      };
    }

    // Get the refresh token
    const refreshToken = await getStoredRefreshToken(
      this.backend,
      connectionId,
    );
    if (!refreshToken) {
      return {
        ok: false,
        error: `Token for OAuth connection "${connectionId}" is expired and no refresh ` +
          `token is available. Re-authorization required.`,
      };
    }

    try {
      // Use deduplicator to prevent concurrent refresh attempts
      const tokenRefreshFn = this.tokenRefreshFn;
      const backend = this.backend;
      const circuitBreaker = this.circuitBreaker;

      const newAccessToken = await this.deduplicator.deduplicate(
        connectionId,
        async () => {
          const result = await tokenRefreshFn(connectionId, refreshToken);
          if (!result.success) {
            circuitBreaker.recordFailure(connectionId);
            throw new Error(result.error);
          }

          circuitBreaker.recordSuccess(connectionId);

          // Persist the refreshed tokens to the secure-key backend
          // (but NOT to any assistant-visible state)
          const persisted = await persistRefreshedTokens(
            backend,
            connectionId,
            {
              accessToken: result.accessToken,
              expiresIn: result.expiresAt
                ? Math.floor((result.expiresAt - Date.now()) / 1000)
                : null,
            },
          );

          return persisted.accessToken;
        },
      );

      return {
        ok: true,
        credential: {
          value: newAccessToken,
          handleType: HandleType.LocalOAuth,
          expiresAt: null, // Refresh result expiry is tracked internally
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Failed to refresh token for OAuth connection "${connectionId}": ${message}`,
      };
    }
  }

  /**
   * Reset circuit breaker and deduplicator state (primarily for testing).
   */
  reset(): void {
    this.circuitBreaker.clear();
    this.deduplicator.clear();
  }
}
