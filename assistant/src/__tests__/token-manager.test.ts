import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Use encrypted backend with a temp store path
// ---------------------------------------------------------------------------
import { _resetBackend, setSecureKeyAsync } from "../security/secure-keys.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";

const TEST_DIR = join(
  tmpdir(),
  `vellum-token-manager-test-${randomBytes(4).toString("hex")}`,
);
const STORE_PATH = join(TEST_DIR, "keys.enc");

// ---------------------------------------------------------------------------
// Mock OAuth2 token refresh so dedup can be observed without network I/O
// ---------------------------------------------------------------------------

let mockRefreshOAuth2Token: ReturnType<
  typeof mock<
    (
      tokenExchangeUrl: string,
      clientId: string,
      refreshToken: string,
      clientSecret?: string,
      tokenEndpointAuthMethod?: string,
    ) => Promise<{ accessToken: string; expiresIn: number }>
  >
>;

mock.module("../security/oauth2.js", () => {
  mockRefreshOAuth2Token = mock(() =>
    Promise.resolve({
      accessToken: "refreshed-access-token",
      expiresIn: 3600,
    }),
  );
  return {
    refreshOAuth2Token: mockRefreshOAuth2Token,
  };
});

// ---------------------------------------------------------------------------
// Mock oauth-store — token-manager reads refresh config from SQLite
// ---------------------------------------------------------------------------

/** Mutable per-test map of provider connections for getConnectionByProvider */
const mockConnections = new Map<
  string,
  {
    id: string;
    provider: string;
    oauthAppId: string;
    expiresAt: number | null;
  }
>();
const mockApps = new Map<
  string,
  {
    id: string;
    provider: string;
    clientId: string;
    clientSecretCredentialPath: string;
  }
>();
const mockProviders = new Map<
  string,
  {
    key: string;
    tokenExchangeUrl: string;
    refreshUrl?: string | null;
    tokenEndpointAuthMethod?: string;
  }
>();

mock.module("../oauth/oauth-store.js", () => ({
  getConnectionByProvider: (service: string) => mockConnections.get(service),
  getConnection: (id: string) => {
    for (const conn of mockConnections.values()) {
      if (conn.id === id) return conn;
    }
    return undefined;
  },
  getApp: (id: string) => mockApps.get(id),
  getProvider: (key: string) => mockProviders.get(key),
  updateConnection: () => {},
}));

// ---------------------------------------------------------------------------
// Import the modules under test
// ---------------------------------------------------------------------------

import {
  _resetInflightRefreshes,
  _resetRefreshBreakers,
  withValidToken,
} from "../security/token-manager.js";
import { _setMetadataPath } from "../tools/credentials/metadata-store.js";

describe("withValidToken refresh deduplication", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  beforeEach(() => {
    _resetBackend();
    for (const entry of readdirSync(TEST_DIR)) {
      rmSync(join(TEST_DIR, entry), { recursive: true, force: true });
    }
    setStorePathForTesting(STORE_PATH);
    _setMetadataPath(join(TEST_DIR, "metadata.json"));
    _resetRefreshBreakers();
    _resetInflightRefreshes();
    mockRefreshOAuth2Token.mockClear();
    // Clear mock oauth-store maps
    mockConnections.clear();
    mockApps.clear();
    mockProviders.clear();
  });

  afterEach(() => {
    _setMetadataPath(null);
    setStorePathForTesting(null);
    _resetBackend();
    _resetRefreshBreakers();
    _resetInflightRefreshes();
    mockConnections.clear();
    mockApps.clear();
    mockProviders.clear();
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /**
   * Helper: set up a service with an access token, refresh token, and
   * mock DB data so that token refresh can proceed through doRefresh().
   *
   * OAuth-specific fields (tokenExchangeUrl, clientId, expiresAt) are stored
   * in the SQLite oauth-store. The mock maps simulate the DB layer.
   */
  async function setupService(
    service: string,
    opts?: { expired?: boolean; accessToken?: string },
  ) {
    const accessToken = opts?.accessToken ?? "old-access-token";

    // Seed mock oauth-store maps so token-manager can resolve refresh config
    const appId = `app-${service}`;
    const connId = `conn-${service}`;

    // Store access token under the oauth_connection key path that
    // withValidToken reads (not the legacy credentialKey path).
    await setSecureKeyAsync(
      `oauth_connection/${connId}/access_token`,
      accessToken,
    );
    mockProviders.set(service, {
      key: service,
      tokenExchangeUrl: "https://oauth.example.com/token",
      refreshUrl: null,
    });
    mockApps.set(appId, {
      id: appId,
      provider: service,
      clientId: "test-client-id",
      clientSecretCredentialPath: `oauth_app/${appId}/client_secret`,
    });
    mockConnections.set(service, {
      id: connId,
      provider: service,
      oauthAppId: appId,
      expiresAt: opts?.expired
        ? Date.now() - 60_000 // expired 1 minute ago
        : Date.now() + 3600_000, // expires in 1 hour
    });
    // Store refresh token and client_secret in secure keys (token-manager reads them)
    await setSecureKeyAsync(
      `oauth_connection/${connId}/refresh_token`,
      "valid-refresh-token",
    );
    await setSecureKeyAsync(
      `oauth_app/${appId}/client_secret`,
      "test-client-secret",
    );
  }

  test("3 concurrent 401 refreshes for the same service call doRefresh exactly once", async () => {
    await setupService("google");

    let resolveRefresh!: (value: {
      accessToken: string;
      expiresIn: number;
    }) => void;
    const refreshPromise = new Promise<{
      accessToken: string;
      expiresIn: number;
    }>((resolve) => {
      resolveRefresh = resolve;
    });

    mockRefreshOAuth2Token.mockImplementation(() => refreshPromise);

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    const callback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return `result-with-${token}`;
    };

    // Launch 3 concurrent withValidToken calls — all will get a non-expired
    // token first, call the callback, get a 401, and then try to refresh.
    const p1 = withValidToken("google", callback);
    const p2 = withValidToken("google", callback);
    const p3 = withValidToken("google", callback);

    // Let the event loop tick so all 3 calls enter the 401 retry path
    await new Promise((r) => setTimeout(r, 10));

    // Resolve the single refresh attempt
    resolveRefresh({ accessToken: "new-token-123", expiresIn: 3600 });

    const results = await Promise.all([p1, p2, p3]);

    // All 3 should succeed with the refreshed token
    expect(results).toEqual([
      "result-with-new-token-123",
      "result-with-new-token-123",
      "result-with-new-token-123",
    ]);

    // refreshOAuth2Token should have been called exactly once
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
  });

  test("concurrent refreshes for different services proceed independently", async () => {
    await setupService("google");
    await setupService("slack");

    let resolveGmail!: (value: {
      accessToken: string;
      expiresIn: number;
    }) => void;
    let resolveSlack!: (value: {
      accessToken: string;
      expiresIn: number;
    }) => void;

    const gmailPromise = new Promise<{
      accessToken: string;
      expiresIn: number;
    }>((resolve) => {
      resolveGmail = resolve;
    });
    const slackPromise = new Promise<{
      accessToken: string;
      expiresIn: number;
    }>((resolve) => {
      resolveSlack = resolve;
    });

    let refreshCallCount = 0;
    mockRefreshOAuth2Token.mockImplementation(() => {
      refreshCallCount++;
      // Both services use the same tokenExchangeUrl in this test, so we track by
      // call order to return the correct deferred promise.
      if (refreshCallCount === 1) return gmailPromise;
      return slackPromise;
    });

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    const gmailCallback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return `gmail-${token}`;
    };
    const slackCallback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return `slack-${token}`;
    };

    const p1 = withValidToken("google", gmailCallback);
    const p2 = withValidToken("slack", slackCallback);

    await new Promise((r) => setTimeout(r, 10));

    // Resolve both independently
    resolveGmail({ accessToken: "gmail-new-token", expiresIn: 3600 });
    resolveSlack({ accessToken: "slack-new-token", expiresIn: 3600 });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("gmail-gmail-new-token");
    expect(r2).toBe("slack-slack-new-token");

    // Both services should have triggered their own refresh
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(2);
  });

  test("deduplication cleans up after refresh completes, allowing subsequent refreshes", async () => {
    await setupService("google");

    let refreshCount = 0;
    mockRefreshOAuth2Token.mockImplementation(() => {
      refreshCount++;
      return Promise.resolve({
        accessToken: `token-${refreshCount}`,
        expiresIn: 3600,
      });
    });

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    // First call triggers a refresh (old token → 401 → refresh → token-1)
    const r1 = await withValidToken("google", async (token: string) => {
      if (token !== "token-1") throw err401;
      return token;
    });
    expect(r1).toBe("token-1");
    expect(refreshCount).toBe(1);

    // Second call also triggers a 401 to verify dedup state was cleaned up
    // and a new refresh is allowed (not deduplicated with the first).
    const r2 = await withValidToken("google", async (token: string) => {
      if (token !== "token-2") throw err401;
      return token;
    });
    expect(r2).toBe("token-2");
    // Second refresh should have happened (not deduplicated with the first,
    // since the first already completed)
    expect(refreshCount).toBe(2);
  });

  test("deduplication propagates refresh errors to all waiting callers", async () => {
    await setupService("google");

    mockRefreshOAuth2Token.mockImplementation(() =>
      Promise.reject(
        Object.assign(
          new Error("OAuth2 token refresh failed (HTTP 401: invalid_grant)"),
        ),
      ),
    );

    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

    const callback = async (token: string) => {
      if (token === "old-access-token") throw err401;
      return "should-not-reach";
    };

    // Launch 2 concurrent calls — both should fail with the same error
    const p1 = withValidToken("google", callback);
    const p2 = withValidToken("google", callback);

    const results = await Promise.allSettled([p1, p2]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");

    // Only one actual refresh attempt
    expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // refreshUrl resolution — provider.refreshUrl with fallback to tokenExchangeUrl
  // -----------------------------------------------------------------------
  describe("refreshUrl resolution", () => {
    test("uses provider.refreshUrl when set", async () => {
      await setupService("google");
      mockProviders.get("google")!.refreshUrl =
        "https://refresh.example.com/token";

      mockRefreshOAuth2Token.mockImplementation(() =>
        Promise.resolve({
          accessToken: "new-token-from-refresh-url",
          expiresIn: 3600,
        }),
      );

      const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

      const callback = async (token: string) => {
        if (token === "old-access-token") throw err401;
        return `result-with-${token}`;
      };

      const result = await withValidToken("google", callback);

      expect(result).toBe("result-with-new-token-from-refresh-url");
      expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
      // Assert the refresh endpoint passed in is provider.refreshUrl, not
      // the tokenExchangeUrl fallback.
      expect(mockRefreshOAuth2Token.mock.calls[0]?.[0]).toBe(
        "https://refresh.example.com/token",
      );
    });

    test("falls back to provider.tokenExchangeUrl when refreshUrl is null", async () => {
      // setupService sets refreshUrl: null by default — this exercises the
      // fallback path explicitly.
      await setupService("google");
      expect(mockProviders.get("google")!.refreshUrl).toBeNull();

      mockRefreshOAuth2Token.mockImplementation(() =>
        Promise.resolve({
          accessToken: "new-token-from-token-exchange-url",
          expiresIn: 3600,
        }),
      );

      const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

      const callback = async (token: string) => {
        if (token === "old-access-token") throw err401;
        return `result-with-${token}`;
      };

      const result = await withValidToken("google", callback);

      expect(result).toBe("result-with-new-token-from-token-exchange-url");
      expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
      // Assert the refresh endpoint falls back to tokenExchangeUrl.
      expect(mockRefreshOAuth2Token.mock.calls[0]?.[0]).toBe(
        "https://oauth.example.com/token",
      );
    });

    test("falls back to provider.tokenExchangeUrl when refreshUrl is undefined", async () => {
      await setupService("google");
      // Delete the refreshUrl field entirely so the property is `undefined`
      // rather than `null`. Both representations of "not set" must produce
      // the fallback behavior.
      delete mockProviders.get("google")!.refreshUrl;
      expect(mockProviders.get("google")!.refreshUrl).toBeUndefined();

      mockRefreshOAuth2Token.mockImplementation(() =>
        Promise.resolve({
          accessToken: "new-token-from-token-exchange-url",
          expiresIn: 3600,
        }),
      );

      const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

      const callback = async (token: string) => {
        if (token === "old-access-token") throw err401;
        return `result-with-${token}`;
      };

      const result = await withValidToken("google", callback);

      expect(result).toBe("result-with-new-token-from-token-exchange-url");
      expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
      // Assert the refresh endpoint falls back to tokenExchangeUrl.
      expect(mockRefreshOAuth2Token.mock.calls[0]?.[0]).toBe(
        "https://oauth.example.com/token",
      );
    });

    test("falls back to provider.tokenExchangeUrl when refreshUrl is empty string", async () => {
      // Platform's Python `oauth_app.refresh_url or oauth_app.token_exchange_url`
      // treats an empty string as unset. We use `||` (not `??`) so empty
      // strings follow the same fallback path and never resolve to an empty
      // endpoint.
      await setupService("google");
      mockProviders.get("google")!.refreshUrl = "";

      mockRefreshOAuth2Token.mockImplementation(() =>
        Promise.resolve({
          accessToken: "new-token-from-token-exchange-url",
          expiresIn: 3600,
        }),
      );

      const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });

      const callback = async (token: string) => {
        if (token === "old-access-token") throw err401;
        return `result-with-${token}`;
      };

      const result = await withValidToken("google", callback);

      expect(result).toBe("result-with-new-token-from-token-exchange-url");
      expect(mockRefreshOAuth2Token).toHaveBeenCalledTimes(1);
      // Assert the refresh endpoint falls back to tokenExchangeUrl — NOT "".
      expect(mockRefreshOAuth2Token.mock.calls[0]?.[0]).toBe(
        "https://oauth.example.com/token",
      );
    });
  });
});
