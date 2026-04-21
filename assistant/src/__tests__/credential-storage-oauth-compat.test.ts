/**
 * Compatibility tests for OAuth primitives extracted into
 * @vellumai/credential-storage.
 *
 * Verifies that the shared helpers produce identical key paths, expiry
 * calculations, circuit breaker behavior, credential error classification,
 * and token persistence results as the original inline implementations.
 */

import { describe, expect, test } from "bun:test";

import {
  computeExpiresAt,
  deleteOAuthTokens,
  EXPIRY_BUFFER_MS,
  getStoredAccessToken,
  getStoredRefreshToken,
  isCredentialError,
  isTokenExpired,
  oauthAppClientSecretPath,
  oauthConnectionAccessTokenPath,
  oauthConnectionRefreshTokenPath,
  persistOAuthTokens,
  persistRefreshedTokens,
  REFRESH_FAILURE_THRESHOLD,
  RefreshCircuitBreaker,
  RefreshDeduplicator,
  type SecureKeyBackend,
  type SecureKeyDeleteResult,
} from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// In-memory SecureKeyBackend for testing
// ---------------------------------------------------------------------------

function createMemoryBackend(): SecureKeyBackend & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => {
      store.set(key, value);
      return true;
    },
    delete: async (key: string): Promise<SecureKeyDeleteResult> => {
      if (store.has(key)) {
        store.delete(key);
        return "deleted";
      }
      return "not-found";
    },
    list: async () => Array.from(store.keys()),
  };
}

// ---------------------------------------------------------------------------
// Secure-key path conventions
// ---------------------------------------------------------------------------

describe("OAuth secure-key path conventions", () => {
  test("access token path matches hardcoded format", () => {
    const connId = "conn-abc-123";
    expect(oauthConnectionAccessTokenPath(connId)).toBe(
      `oauth_connection/${connId}/access_token`,
    );
  });

  test("refresh token path matches hardcoded format", () => {
    const connId = "conn-xyz-456";
    expect(oauthConnectionRefreshTokenPath(connId)).toBe(
      `oauth_connection/${connId}/refresh_token`,
    );
  });

  test("client secret path matches hardcoded format", () => {
    const appId = "app-def-789";
    expect(oauthAppClientSecretPath(appId)).toBe(
      `oauth_app/${appId}/client_secret`,
    );
  });
});

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------

describe("isTokenExpired", () => {
  test("null expiresAt is not expired", () => {
    expect(isTokenExpired(null)).toBe(false);
  });

  test("future expiry outside buffer is not expired", () => {
    const future = Date.now() + EXPIRY_BUFFER_MS + 60_000;
    expect(isTokenExpired(future)).toBe(false);
  });

  test("expiry within buffer window is expired", () => {
    const withinBuffer = Date.now() + EXPIRY_BUFFER_MS - 1_000;
    expect(isTokenExpired(withinBuffer)).toBe(true);
  });

  test("past expiry is expired", () => {
    const past = Date.now() - 60_000;
    expect(isTokenExpired(past)).toBe(true);
  });

  test("custom buffer is respected", () => {
    const ts = Date.now() + 10_000;
    expect(isTokenExpired(ts, 5_000)).toBe(false);
    expect(isTokenExpired(ts, 15_000)).toBe(true);
  });

  test("EXPIRY_BUFFER_MS is 5 minutes", () => {
    expect(EXPIRY_BUFFER_MS).toBe(5 * 60 * 1000);
  });
});

describe("computeExpiresAt", () => {
  test("null input returns null", () => {
    expect(computeExpiresAt(null)).toBeNull();
  });

  test("undefined input returns null", () => {
    expect(computeExpiresAt(undefined)).toBeNull();
  });

  test("zero returns null", () => {
    expect(computeExpiresAt(0)).toBeNull();
  });

  test("negative returns null", () => {
    expect(computeExpiresAt(-10)).toBeNull();
  });

  test("positive value computes future timestamp", () => {
    const before = Date.now();
    const result = computeExpiresAt(3600);
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(result!).toBeLessThanOrEqual(after + 3600 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Stored token lookup
// ---------------------------------------------------------------------------

describe("stored token lookup", () => {
  test("getStoredAccessToken retrieves from correct path", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-1";
    backend.store.set(
      `oauth_connection/${connId}/access_token`,
      "access-tok-123",
    );

    const result = await getStoredAccessToken(backend, connId);
    expect(result).toBe("access-tok-123");
  });

  test("getStoredAccessToken returns undefined when missing", async () => {
    const backend = createMemoryBackend();
    const result = await getStoredAccessToken(backend, "nonexistent");
    expect(result).toBeUndefined();
  });

  test("getStoredRefreshToken retrieves from correct path", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-2";
    backend.store.set(
      `oauth_connection/${connId}/refresh_token`,
      "refresh-tok-456",
    );

    const result = await getStoredRefreshToken(backend, connId);
    expect(result).toBe("refresh-tok-456");
  });

  test("getStoredRefreshToken returns undefined when missing", async () => {
    const backend = createMemoryBackend();
    const result = await getStoredRefreshToken(backend, "nonexistent");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

describe("persistOAuthTokens", () => {
  test("stores access and refresh tokens at correct paths", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-persist-1";

    await persistOAuthTokens(backend, connId, {
      accessToken: "access-123",
      refreshToken: "refresh-456",
    });

    expect(backend.store.get(`oauth_connection/${connId}/access_token`)).toBe(
      "access-123",
    );
    expect(backend.store.get(`oauth_connection/${connId}/refresh_token`)).toBe(
      "refresh-456",
    );
  });

  test("clears stale refresh token when not provided", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-persist-2";

    // Pre-populate a refresh token
    backend.store.set(
      `oauth_connection/${connId}/refresh_token`,
      "old-refresh",
    );

    await persistOAuthTokens(backend, connId, {
      accessToken: "new-access",
      // no refreshToken — should clear the old one
    });

    expect(backend.store.get(`oauth_connection/${connId}/access_token`)).toBe(
      "new-access",
    );
    expect(backend.store.has(`oauth_connection/${connId}/refresh_token`)).toBe(
      false,
    );
  });

  test("throws when access token storage fails", async () => {
    const backend = createMemoryBackend();
    backend.set = async () => false; // Simulate storage failure
    const connId = "conn-fail";

    await expect(
      persistOAuthTokens(backend, connId, { accessToken: "tok" }),
    ).rejects.toThrow("Failed to store access token in secure storage");
  });
});

// ---------------------------------------------------------------------------
// Refresh-on-expiry: persistRefreshedTokens
// ---------------------------------------------------------------------------

describe("persistRefreshedTokens", () => {
  test("persists refreshed tokens and computes expiresAt", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-refresh-1";

    const before = Date.now();
    const result = await persistRefreshedTokens(backend, connId, {
      accessToken: "new-access-tok",
      refreshToken: "new-refresh-tok",
      expiresIn: 3600,
    });
    const after = Date.now();

    expect(result.accessToken).toBe("new-access-tok");
    expect(result.hasRefreshToken).toBe(true);
    expect(result.expiresAt).not.toBeNull();
    expect(result.expiresAt!).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(result.expiresAt!).toBeLessThanOrEqual(after + 3600 * 1000);

    expect(backend.store.get(`oauth_connection/${connId}/access_token`)).toBe(
      "new-access-tok",
    );
    expect(backend.store.get(`oauth_connection/${connId}/refresh_token`)).toBe(
      "new-refresh-tok",
    );
  });

  test("returns null expiresAt when expiresIn is zero", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-refresh-2";

    const result = await persistRefreshedTokens(backend, connId, {
      accessToken: "tok",
      expiresIn: 0,
    });

    expect(result.expiresAt).toBeNull();
    expect(result.hasRefreshToken).toBe(false);
  });

  test("returns null expiresAt when expiresIn is null", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-refresh-3";

    const result = await persistRefreshedTokens(backend, connId, {
      accessToken: "tok",
      expiresIn: null,
    });

    expect(result.expiresAt).toBeNull();
  });

  test("throws when access token storage fails", async () => {
    const backend = createMemoryBackend();
    backend.set = async () => false;

    await expect(
      persistRefreshedTokens(backend, "conn-x", {
        accessToken: "tok",
      }),
    ).rejects.toThrow("Failed to store refreshed access token");
  });
});

// ---------------------------------------------------------------------------
// Delete OAuth tokens
// ---------------------------------------------------------------------------

describe("deleteOAuthTokens", () => {
  test("deletes both access and refresh tokens", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-del-1";
    backend.store.set(`oauth_connection/${connId}/access_token`, "at");
    backend.store.set(`oauth_connection/${connId}/refresh_token`, "rt");

    const result = await deleteOAuthTokens(backend, connId);

    expect(result.accessTokenResult).toBe("deleted");
    expect(result.refreshTokenResult).toBe("deleted");
    expect(backend.store.size).toBe(0);
  });

  test("returns not-found for missing tokens", async () => {
    const backend = createMemoryBackend();

    const result = await deleteOAuthTokens(backend, "nonexistent");

    expect(result.accessTokenResult).toBe("not-found");
    expect(result.refreshTokenResult).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// Missing refresh config edge case
// ---------------------------------------------------------------------------

describe("missing refresh config", () => {
  test("getStoredRefreshToken returns undefined for connection without refresh token", async () => {
    const backend = createMemoryBackend();
    // Only set access token, no refresh token
    backend.store.set("oauth_connection/conn-no-refresh/access_token", "at");

    const refresh = await getStoredRefreshToken(backend, "conn-no-refresh");
    expect(refresh).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("RefreshCircuitBreaker", () => {
  test("starts closed", () => {
    const breaker = new RefreshCircuitBreaker();
    expect(breaker.isOpen("service-1")).toBe(false);
  });

  test("stays closed below failure threshold", () => {
    const breaker = new RefreshCircuitBreaker();
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD - 1; i++) {
      breaker.recordFailure("service-2");
    }
    expect(breaker.isOpen("service-2")).toBe(false);
  });

  test("opens at failure threshold", () => {
    const breaker = new RefreshCircuitBreaker();
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD; i++) {
      breaker.recordFailure("service-3");
    }
    expect(breaker.isOpen("service-3")).toBe(true);
  });

  test("success resets the breaker", () => {
    const breaker = new RefreshCircuitBreaker();
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD; i++) {
      breaker.recordFailure("service-4");
    }
    expect(breaker.isOpen("service-4")).toBe(true);

    breaker.recordSuccess("service-4");
    expect(breaker.isOpen("service-4")).toBe(false);
    expect(breaker.getState("service-4")).toBeUndefined();
  });

  test("clear resets all breakers", () => {
    const breaker = new RefreshCircuitBreaker();
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD; i++) {
      breaker.recordFailure("a");
      breaker.recordFailure("b");
    }
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.isOpen("b")).toBe(true);

    breaker.clear();
    expect(breaker.isOpen("a")).toBe(false);
    expect(breaker.isOpen("b")).toBe(false);
  });

  test("independent services don't affect each other", () => {
    const breaker = new RefreshCircuitBreaker();
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD; i++) {
      breaker.recordFailure("service-x");
    }
    expect(breaker.isOpen("service-x")).toBe(true);
    expect(breaker.isOpen("service-y")).toBe(false);
  });

  test("transient (non-credential) failures do not trip the breaker", () => {
    const breaker = new RefreshCircuitBreaker();
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD + 5; i++) {
      breaker.recordFailure("transient-svc", false);
    }
    expect(breaker.isOpen("transient-svc")).toBe(false);
    expect(breaker.getState("transient-svc")).toBeUndefined();
  });

  test("tracks isCredentialError flag on breaker state", () => {
    const breaker = new RefreshCircuitBreaker();
    for (let i = 0; i < REFRESH_FAILURE_THRESHOLD; i++) {
      breaker.recordFailure("cred-svc", true);
    }
    expect(breaker.isOpen("cred-svc")).toBe(true);
    expect(breaker.getState("cred-svc")!.isCredentialError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refresh deduplication
// ---------------------------------------------------------------------------

describe("RefreshDeduplicator", () => {
  test("deduplicates concurrent calls for the same key", async () => {
    const dedup = new RefreshDeduplicator();
    let callCount = 0;

    const refreshFn = async () => {
      callCount++;
      return "token-abc";
    };

    const [r1, r2, r3] = await Promise.all([
      dedup.deduplicate("conn-1", refreshFn),
      dedup.deduplicate("conn-1", refreshFn),
      dedup.deduplicate("conn-1", refreshFn),
    ]);

    expect(r1).toBe("token-abc");
    expect(r2).toBe("token-abc");
    expect(r3).toBe("token-abc");
    expect(callCount).toBe(1);
  });

  test("different keys get independent calls", async () => {
    const dedup = new RefreshDeduplicator();
    let callCount = 0;

    const refreshFn = async () => {
      callCount++;
      return `token-${callCount}`;
    };

    const [r1, r2] = await Promise.all([
      dedup.deduplicate("conn-a", refreshFn),
      dedup.deduplicate("conn-b", refreshFn),
    ]);

    expect(callCount).toBe(2);
    expect(r1).not.toBe(r2);
  });

  test("propagates errors to all joined callers", async () => {
    const dedup = new RefreshDeduplicator();

    const refreshFn = async () => {
      throw new Error("refresh failed");
    };

    const results = await Promise.allSettled([
      dedup.deduplicate("conn-err", refreshFn),
      dedup.deduplicate("conn-err", refreshFn),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
  });

  test("clears in-flight state after completion", async () => {
    const dedup = new RefreshDeduplicator();
    let callCount = 0;

    await dedup.deduplicate("conn-c", async () => {
      callCount++;
      return "first";
    });

    const result = await dedup.deduplicate("conn-c", async () => {
      callCount++;
      return "second";
    });

    expect(callCount).toBe(2);
    expect(result).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// Credential error classification
// ---------------------------------------------------------------------------

describe("isCredentialError", () => {
  test("non-Error is not a credential error", () => {
    expect(isCredentialError("string error")).toBe(false);
    expect(isCredentialError(null)).toBe(false);
    expect(isCredentialError(42)).toBe(false);
  });

  test("401 is a credential error", () => {
    expect(isCredentialError(new Error("HTTP 401: Unauthorized"))).toBe(true);
  });

  test("403 is a credential error", () => {
    expect(isCredentialError(new Error("HTTP 403: Forbidden"))).toBe(true);
  });

  test("400 with invalid_grant is a credential error", () => {
    expect(
      isCredentialError(
        new Error("OAuth2 token refresh failed (HTTP 400: invalid_grant)"),
      ),
    ).toBe(true);
  });

  test("400 with invalid_client is a credential error", () => {
    expect(
      isCredentialError(
        new Error("OAuth2 token refresh failed (HTTP 400: invalid_client)"),
      ),
    ).toBe(true);
  });

  test("400 without invalid_grant/invalid_client is transient", () => {
    expect(
      isCredentialError(
        new Error("OAuth2 token refresh failed (HTTP 400: bad_request)"),
      ),
    ).toBe(false);
  });

  test("500 is transient (not credential error)", () => {
    expect(
      isCredentialError(new Error("OAuth2 token refresh failed (HTTP 500)")),
    ).toBe(false);
  });

  test("network error is transient", () => {
    expect(isCredentialError(new Error("fetch failed"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Disconnected / local OAuth edge cases
// ---------------------------------------------------------------------------

describe("disconnected OAuth edge cases", () => {
  test("deleteOAuthTokens gracefully handles missing tokens", async () => {
    const backend = createMemoryBackend();
    // Only access token exists, no refresh token
    backend.store.set("oauth_connection/conn-partial/access_token", "at");

    const result = await deleteOAuthTokens(backend, "conn-partial");
    expect(result.accessTokenResult).toBe("deleted");
    expect(result.refreshTokenResult).toBe("not-found");
  });

  test("persistOAuthTokens followed by deleteOAuthTokens round-trips cleanly", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-roundtrip";

    // Store tokens
    await persistOAuthTokens(backend, connId, {
      accessToken: "at-1",
      refreshToken: "rt-1",
    });
    expect(backend.store.size).toBe(2);

    // Delete tokens
    const result = await deleteOAuthTokens(backend, connId);
    expect(result.accessTokenResult).toBe("deleted");
    expect(result.refreshTokenResult).toBe("deleted");
    expect(backend.store.size).toBe(0);
  });

  test("re-persist after delete stores new tokens correctly", async () => {
    const backend = createMemoryBackend();
    const connId = "conn-re-persist";

    // First persist
    await persistOAuthTokens(backend, connId, {
      accessToken: "at-1",
      refreshToken: "rt-1",
    });

    // Delete
    await deleteOAuthTokens(backend, connId);

    // Re-persist with different tokens
    await persistOAuthTokens(backend, connId, {
      accessToken: "at-2",
      refreshToken: "rt-2",
    });

    expect(await getStoredAccessToken(backend, connId)).toBe("at-2");
    expect(await getStoredRefreshToken(backend, connId)).toBe("rt-2");
  });
});
