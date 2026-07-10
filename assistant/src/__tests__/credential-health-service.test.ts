import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mutable state for mocks ──────────────────────────────────────────

const secureKeyValues = new Map<string, string>();
const unreachableKeys = new Set<string>();

let mockProviders: Array<{
  provider: string;
  defaultScopes: string;
  pingUrl: string | null;
  pingMethod: string | null;
  pingHeaders: string | null;
  pingBody: string | null;
  managedServiceConfigKey?: string;
}> = [];

let mockConnections: Map<
  string,
  Array<{
    id: string;
    provider: string;
    accountInfo: string | null;
    grantedScopes: string;
    expiresAt: number | null;
    hasRefreshToken: number;
    status: string;
  }>
> = new Map();

let mockFetchResponse: { ok: boolean; status: number } = {
  ok: true,
  status: 200,
};
let mockFetchThrows = false;

// Per-test refresh outcome — drives the withValidToken mock.
//   "ok"          → refresh succeeds (or wasn't needed); callback runs with token
//   "refresh_failed" → refresh throws TokenExpiredError (revoked refresh token)
type RefreshOutcome = "ok" | "refresh_failed";
let mockRefreshOutcome: RefreshOutcome = "ok";

// Managed-path mock state.
let managedListResponse: {
  ok: boolean;
  status: number;
  body?: unknown;
} = { ok: true, status: 200, body: { results: [] } };
let managedPingOutcome:
  | { kind: "status"; status: number }
  | { kind: "credential_required" }
  | { kind: "throw"; message: string } = { kind: "status", status: 200 };

// ── Module mocks ─────────────────────────────────────────────────────

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
  getSecureKeyResultAsync: async (account: string) => ({
    value: secureKeyValues.get(account),
    unreachable: unreachableKeys.has(account),
  }),
  setSecureKeyAsync: async () => {},
  deleteSecureKeyAsync: async () => "deleted",
  listSecureKeysAsync: async () => [],
  getProviderKeyAsync: async () => undefined,
  getMaskedProviderKey: () => undefined,
}));

mock.module("../oauth/oauth-store.js", () => ({
  listProviders: () => mockProviders,
  listActiveConnectionsByProvider: (provider: string) =>
    mockConnections.get(provider) ?? [],
  getProvider: (provider: string) =>
    mockProviders.find((p) => p.provider === provider),
  isProviderConnected: () => false,
  // Needed by manual-token-connection.ts at import time — these aren't
  // invoked in this test suite but must resolve so the module loads.
  createConnection: () => {
    throw new Error("createConnection not mocked");
  },
  deleteConnection: () => {
    throw new Error("deleteConnection not mocked");
  },
  getConnectionByProvider: () => undefined,
  updateConnection: () => {
    throw new Error("updateConnection not mocked");
  },
  upsertApp: async () => {
    throw new Error("upsertApp not mocked");
  },
}));

class MockTokenExpiredError extends Error {
  constructor(service: string, message?: string) {
    super(message ?? `Token expired for "${service}"`);
    this.name = "TokenExpiredError";
  }
}

mock.module("../security/token-manager.js", () => ({
  TokenExpiredError: MockTokenExpiredError,
  withValidToken: async (
    service: string,
    callback: (token: string) => Promise<unknown>,
    opts: { connectionId: string },
  ) => {
    if (mockRefreshOutcome === "refresh_failed") {
      throw new MockTokenExpiredError(service);
    }
    const token =
      secureKeyValues.get(
        `oauth_connection/${opts.connectionId}/access_token`,
      ) ?? "refreshed-token";
    return callback(token);
  },
}));

// Managed-path mocks: platform client and PlatformOAuthConnection. The
// managed code path uses dynamic imports for these so they only matter when
// a managed test scenario is exercised. The managed/your-own service mode is
// seeded into the real workspace config via `seedGoogleOAuthMode` below.
mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => ({
      platformAssistantId: "test-assistant",
      fetch: async (_path: string) => ({
        ok: managedListResponse.ok,
        status: managedListResponse.status,
        json: async () => managedListResponse.body ?? { results: [] },
      }),
    }),
  },
}));

class MockCredentialRequiredError extends Error {
  constructor() {
    super("credential required");
    this.name = "CredentialRequiredError";
  }
}

mock.module("../oauth/platform-connection.js", () => ({
  PlatformOAuthConnection: class {
    constructor(_opts: unknown) {}
    async request(_req: unknown) {
      if (managedPingOutcome.kind === "credential_required") {
        throw new MockCredentialRequiredError();
      }
      if (managedPingOutcome.kind === "throw") {
        throw new Error(managedPingOutcome.message);
      }
      return {
        status: managedPingOutcome.status,
        headers: {},
        body: {},
      };
    }
  },
}));

// ── Import under test ────────────────────────────────────────────────

import { setConfig } from "./helpers/set-config.js";

const { checkAllCredentials, checkCredentialForProvider, _setFetchFn } =
  await import("../credential-health/credential-health-service.js");

/** Seed the real workspace config's `services.google-oauth.mode`. */
function seedGoogleOAuthMode(mode: "managed" | "your-own"): void {
  setConfig("services", { "google-oauth": { mode } });
}

// Inject mock fetch via the test helper (Bun's global fetch can't be
// overridden via globalThis assignment).
_setFetchFn((async () => {
  if (mockFetchThrows) {
    throw new Error("Network error");
  }
  return {
    ok: mockFetchResponse.ok,
    status: mockFetchResponse.status,
  } as Response;
}) as unknown as typeof fetch);

// ── Helpers ──────────────────────────────────────────────────────────

function addProvider(
  provider: string,
  opts?: {
    defaultScopes?: string[];
    pingUrl?: string | null;
    pingMethod?: string | null;
    managedServiceConfigKey?: string;
  },
) {
  mockProviders.push({
    provider,
    defaultScopes: JSON.stringify(opts?.defaultScopes ?? []),
    pingUrl: opts?.pingUrl ?? null,
    pingMethod: opts?.pingMethod ?? null,
    pingHeaders: null,
    pingBody: null,
    // checkManagedProvider reads this field via OAuthProviderRow; the
    // health-check code branches to the managed path only when set AND
    // when the corresponding config key's service mode is "managed".
    managedServiceConfigKey: opts?.managedServiceConfigKey,
  });
}

function addConnection(
  provider: string,
  id: string,
  opts?: {
    expiresAt?: number | null;
    hasRefreshToken?: boolean;
    grantedScopes?: string[];
    accountInfo?: string | null;
  },
) {
  const conns = mockConnections.get(provider) ?? [];
  conns.push({
    id,
    provider,
    accountInfo: opts?.accountInfo ?? `user@${provider}.com`,
    grantedScopes: JSON.stringify(opts?.grantedScopes ?? []),
    expiresAt: opts?.expiresAt ?? null,
    hasRefreshToken: opts?.hasRefreshToken ? 1 : 0,
    status: "active",
  });
  mockConnections.set(provider, conns);
}

function setToken(connectionId: string, token = "mock-token") {
  secureKeyValues.set(`oauth_connection/${connectionId}/access_token`, token);
}

function markUnreachable(key: string) {
  unreachableKeys.add(key);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("credential-health-service", () => {
  beforeEach(() => {
    secureKeyValues.clear();
    unreachableKeys.clear();
    mockProviders = [];
    mockConnections = new Map();
    mockFetchResponse = { ok: true, status: 200 };
    mockFetchThrows = false;
    mockRefreshOutcome = "ok";
    seedGoogleOAuthMode("your-own");
    managedListResponse = { ok: true, status: 200, body: { results: [] } };
    managedPingOutcome = { kind: "status", status: 200 };
  });

  test("returns empty report when no providers exist", async () => {
    const report = await checkAllCredentials();
    expect(report.results).toHaveLength(0);
    expect(report.unhealthy).toHaveLength(0);
    expect(report.checkedAt).toBeGreaterThan(0);
  });

  test("returns empty report when provider has no connections", async () => {
    addProvider("google");
    const report = await checkAllCredentials();
    expect(report.results).toHaveLength(0);
    expect(report.unhealthy).toHaveLength(0);
  });

  test("returns healthy for connection with valid token and future expiry", async () => {
    addProvider("google");
    addConnection("google", "conn-1", {
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
      hasRefreshToken: true,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.status).toBe("healthy");
    expect(report.unhealthy).toHaveLength(0);
  });

  test("returns missing_token when no access token in secure storage", async () => {
    addProvider("google");
    addConnection("google", "conn-1");
    // Don't set token

    const report = await checkAllCredentials();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.status).toBe("missing_token");
    expect(report.results[0]!.canAutoRecover).toBe(false);
    expect(report.unhealthy).toHaveLength(1);
  });

  test("returns unreachable when credential backend is unreachable", async () => {
    addProvider("google");
    addConnection("google", "conn-1");
    // Don't set token, but mark the path as unreachable
    markUnreachable("oauth_connection/conn-1/access_token");

    const report = await checkAllCredentials();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.status).toBe("unreachable");
    expect(report.results[0]!.canAutoRecover).toBe(true);
    expect(report.unhealthy).toHaveLength(1);
  });

  test("returns missing_token (not unreachable) when backend is reachable but token absent", async () => {
    addProvider("google");
    addConnection("google", "conn-1");
    // Don't set token, don't mark unreachable — genuinely missing

    const report = await checkAllCredentials();
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.status).toBe("missing_token");
    expect(report.results[0]!.canAutoRecover).toBe(false);
  });

  test("returns expired when token is past expiresAt without refresh token", async () => {
    addProvider("google");
    addConnection("google", "conn-1", {
      expiresAt: Date.now() - 60_000, // 1 minute ago
      hasRefreshToken: false,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("expired");
    expect(report.results[0]!.canAutoRecover).toBe(false);
  });

  test("returns healthy when expired token has a refresh token, no ping URL, and refresh succeeds via the ping path", async () => {
    // Without a pingUrl there's no opportunity to exercise the refresh —
    // the connection is reported as healthy on the trust that the next
    // real API call will refresh transparently. This matches the contract
    // for connections that have a refresh token but no liveness endpoint.
    addProvider("google"); // no pingUrl
    addConnection("google", "conn-1", {
      expiresAt: Date.now() - 60_000, // 1 minute ago
      hasRefreshToken: true,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("healthy");
    expect(report.results[0]!.canAutoRecover).toBe(true);
  });

  test("expired BYO token + successful refresh + 200 ping → healthy", async () => {
    // The withValidToken mock returns "refreshed" by default; pingProvider
    // sees a fresh token and the upstream returns 200.
    mockFetchResponse = { ok: true, status: 200 };
    addProvider("google", {
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    addConnection("google", "conn-1", {
      expiresAt: Date.now() - 60_000,
      hasRefreshToken: true,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("healthy");
  });

  test("expired BYO token + refresh fails (revoked refresh token) → revoked", async () => {
    mockRefreshOutcome = "refresh_failed";
    addProvider("google", {
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    addConnection("google", "conn-1", {
      expiresAt: Date.now() - 60_000,
      hasRefreshToken: true,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("revoked");
    expect(report.results[0]!.canAutoRecover).toBe(false);
  });

  test("BYO ping that still returns 401 after a refresh attempt → revoked", async () => {
    // Refresh succeeds (mockRefreshOutcome stays "ok") but the upstream
    // still returns 401 — the token was genuinely revoked by the provider.
    mockFetchResponse = { ok: false, status: 401 };
    addProvider("google", {
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    addConnection("google", "conn-1", {
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      hasRefreshToken: true,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("revoked");
    expect(report.results[0]!.details).toContain("after a refresh attempt");
  });

  test("returns expiring when token expires within 7 days without refresh token", async () => {
    addProvider("google");
    addConnection("google", "conn-1", {
      expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000, // 3 days from now
      hasRefreshToken: false,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("expiring");
    expect(report.results[0]!.canAutoRecover).toBe(false);
  });

  test("returns healthy when token expires within 7 days but has refresh token", async () => {
    addProvider("google");
    addConnection("google", "conn-1", {
      expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000, // 3 days from now
      hasRefreshToken: true,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("healthy");
  });

  test("returns missing_scopes when grantedScopes is subset of defaultScopes", async () => {
    addProvider("slack", {
      defaultScopes: ["chat:write", "channels:read", "im:write"],
    });
    addConnection("slack", "conn-1", {
      grantedScopes: ["chat:write"],
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("missing_scopes");
    expect(report.results[0]!.missingScopes).toEqual([
      "channels:read",
      "im:write",
    ]);
    expect(report.results[0]!.canAutoRecover).toBe(false);
  });

  test("returns revoked when ping returns 401", async () => {
    mockFetchResponse = { ok: false, status: 401 };
    addProvider("google", {
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    addConnection("google", "conn-1", {
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("revoked");
    expect(report.results[0]!.canAutoRecover).toBe(false);
  });

  test("returns ping_failed on non-auth ping error", async () => {
    mockFetchResponse = { ok: false, status: 500 };
    addProvider("google", {
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    addConnection("google", "conn-1", {
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("ping_failed");
  });

  test("returns ping_failed on network error (does not throw)", async () => {
    mockFetchThrows = true;
    addProvider("google", {
      pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    });
    addConnection("google", "conn-1", {
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    // Network error -> ping_failed (non-auth), not an exception
    expect(report.results[0]!.status).toBe("ping_failed");
  });

  test("checks multiple providers and connections", async () => {
    addProvider("google");
    addProvider("slack", {
      defaultScopes: ["chat:write", "channels:read"],
    });

    addConnection("google", "conn-g1");
    setToken("conn-g1");
    addConnection("slack", "conn-s1", {
      grantedScopes: ["chat:write", "channels:read"],
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    setToken("conn-s1");

    const report = await checkAllCredentials();
    expect(report.results).toHaveLength(2);

    const google = report.results.find((r) => r.provider === "google");
    const slack = report.results.find((r) => r.provider === "slack");

    // Google: token set, no expiry -> healthy
    expect(google!.status).toBe("healthy");
    // Slack: all scopes present, valid token -> healthy
    expect(slack!.status).toBe("healthy");
  });

  describe("manual-token providers", () => {
    // slack_channel and telegram store their primary access token at
    // credential/<provider>/bot_token rather than at
    // oauth_connection/<id>/access_token. The health check must resolve the
    // provider-specific path via manualTokenAccessCredentialKey — otherwise
    // every manual-token connection gets flagged as missing_token and ends
    // up in the heartbeat <credential-status> block even when credentials
    // are valid.

    test("slack_channel is healthy when bot_token is present and ping succeeds", async () => {
      addProvider("slack_channel", {
        pingUrl: "https://slack.com/api/auth.test",
      });
      addConnection("slack_channel", "conn-slack", {
        expiresAt: null,
        hasRefreshToken: false,
        grantedScopes: [],
      });
      secureKeyValues.set("credential/slack_channel/bot_token", "xoxb-valid");

      const report = await checkAllCredentials();
      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.status).toBe("healthy");
      expect(report.unhealthy).toHaveLength(0);
    });

    test("slack_channel is missing_token when bot_token is absent, even if OAuth access-token path is populated", async () => {
      addProvider("slack_channel", {
        pingUrl: "https://slack.com/api/auth.test",
      });
      addConnection("slack_channel", "conn-slack", {
        expiresAt: null,
        hasRefreshToken: false,
        grantedScopes: [],
      });
      // Write to the OAuth access-token path — this must be IGNORED for
      // manual-token providers, otherwise the fix isn't routing correctly.
      secureKeyValues.set(
        "oauth_connection/conn-slack/access_token",
        "should-be-ignored",
      );

      const report = await checkAllCredentials();
      expect(report.results[0]!.status).toBe("missing_token");
    });

    test("telegram resolves to credential/telegram/bot_token", async () => {
      addProvider("telegram");
      addConnection("telegram", "conn-tg", {
        expiresAt: null,
        hasRefreshToken: false,
        grantedScopes: [],
      });
      secureKeyValues.set("credential/telegram/bot_token", "telegram-token");

      const report = await checkAllCredentials();
      expect(report.results[0]!.status).toBe("healthy");
    });

    test("slack_channel returns unreachable when credential backend is down", async () => {
      addProvider("slack_channel", {
        pingUrl: "https://slack.com/api/auth.test",
      });
      addConnection("slack_channel", "conn-slack", {
        expiresAt: null,
        hasRefreshToken: false,
        grantedScopes: [],
      });
      // Don't set token, mark the manual-token path as unreachable
      markUnreachable("credential/slack_channel/bot_token");

      const report = await checkAllCredentials();
      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.status).toBe("unreachable");
      expect(report.results[0]!.canAutoRecover).toBe(true);
    });

    test("telegram returns unreachable when credential backend is down", async () => {
      addProvider("telegram");
      addConnection("telegram", "conn-tg", {
        expiresAt: null,
        hasRefreshToken: false,
        grantedScopes: [],
      });
      // Don't set token, mark the manual-token path as unreachable
      markUnreachable("credential/telegram/bot_token");

      const report = await checkAllCredentials();
      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.status).toBe("unreachable");
      expect(report.results[0]!.canAutoRecover).toBe(true);
    });
  });

  describe("managed-provider path", () => {
    // Distinguishing managed-path failure modes: a 424 from the platform
    // proxy (CredentialRequiredError) means the platform tried and gave up
    // on refresh — actionable, fire reconnect alert. A bare 401/403 from
    // the upstream provider could be a transient platform-side miss (proxy
    // didn't refresh-before-forward) and should NOT fire reconnect alerts
    // without further evidence — demote to ping_failed.

    function setupManagedGoogle(opts?: { hasActiveConnection?: boolean }) {
      addProvider("google", {
        pingUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
        managedServiceConfigKey: "google-oauth",
      });
      seedGoogleOAuthMode("managed");
      if (opts?.hasActiveConnection !== false) {
        managedListResponse = {
          ok: true,
          status: 200,
          body: {
            results: [
              {
                id: "platform-conn-1",
                account_label: "user@example.com",
                status: "ACTIVE",
              },
            ],
          },
        };
      }
    }

    test("managed 2xx ping → healthy", async () => {
      setupManagedGoogle();
      managedPingOutcome = { kind: "status", status: 200 };

      const report = await checkAllCredentials();
      const google = report.results.find((r) => r.provider === "google");
      expect(google!.status).toBe("healthy");
    });

    test("managed 424 (CredentialRequiredError) → revoked", async () => {
      setupManagedGoogle();
      managedPingOutcome = { kind: "credential_required" };

      const report = await checkAllCredentials();
      const google = report.results.find((r) => r.provider === "google");
      expect(google!.status).toBe("revoked");
      expect(google!.canAutoRecover).toBe(false);
      expect(google!.details).toContain("cannot be refreshed");
    });

    test("managed 401 from upstream → ping_failed, not revoked", async () => {
      // This is the key change: previously this would fire a user-facing
      // reconnect alert (because "revoked" is in hardFailureStatuses). Now
      // we treat upstream 401 as potentially transient — only a 424 from
      // the platform proxy is trusted enough to trigger the alert.
      setupManagedGoogle();
      managedPingOutcome = { kind: "status", status: 401 };

      const report = await checkAllCredentials();
      const google = report.results.find((r) => r.provider === "google");
      expect(google!.status).toBe("ping_failed");
      expect(google!.status).not.toBe("revoked");
    });

    test("managed 403 from upstream → ping_failed, not revoked", async () => {
      setupManagedGoogle();
      managedPingOutcome = { kind: "status", status: 403 };

      const report = await checkAllCredentials();
      const google = report.results.find((r) => r.provider === "google");
      expect(google!.status).toBe("ping_failed");
    });

    test("managed 500 from upstream → ping_failed", async () => {
      setupManagedGoogle();
      managedPingOutcome = { kind: "status", status: 500 };

      const report = await checkAllCredentials();
      const google = report.results.find((r) => r.provider === "google");
      expect(google!.status).toBe("ping_failed");
    });
  });

  describe("checkCredentialForProvider", () => {
    test("returns null when no connections exist", async () => {
      const result = await checkCredentialForProvider("google");
      expect(result).toBeNull();
    });

    test("returns health result for the most recent connection", async () => {
      addProvider("google");
      addConnection("google", "conn-1", {
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
      setToken("conn-1");

      const result = await checkCredentialForProvider("google");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("healthy");
      expect(result!.connectionId).toBe("conn-1");
    });

    test("returns unhealthy for missing token", async () => {
      addProvider("google");
      addConnection("google", "conn-1");

      const result = await checkCredentialForProvider("google");
      expect(result!.status).toBe("missing_token");
    });
  });
});
