import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mutable state for mocks ──────────────────────────────────────────

const secureKeyValues = new Map<string, string>();

let mockProviders: Array<{
  provider: string;
  defaultScopes: string;
  pingUrl: string | null;
  pingMethod: string | null;
  pingHeaders: string | null;
  pingBody: string | null;
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

// ── Module mocks ─────────────────────────────────────────────────────

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (account: string) => secureKeyValues.get(account),
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
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

// ── Import under test ────────────────────────────────────────────────

const { checkAllCredentials, checkCredentialForProvider, _setFetchFn } =
  await import("../credential-health/credential-health-service.js");

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
  },
) {
  mockProviders.push({
    provider,
    defaultScopes: JSON.stringify(opts?.defaultScopes ?? []),
    pingUrl: opts?.pingUrl ?? null,
    pingMethod: opts?.pingMethod ?? null,
    pingHeaders: null,
    pingBody: null,
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

// ── Tests ────────────────────────────────────────────────────────────

describe("credential-health-service", () => {
  beforeEach(() => {
    secureKeyValues.clear();
    mockProviders = [];
    mockConnections = new Map();
    mockFetchResponse = { ok: true, status: 200 };
    mockFetchThrows = false;
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

  test("returns expiring when token is past expiresAt with refresh token", async () => {
    addProvider("google");
    addConnection("google", "conn-1", {
      expiresAt: Date.now() - 60_000, // 1 minute ago
      hasRefreshToken: true,
    });
    setToken("conn-1");

    const report = await checkAllCredentials();
    expect(report.results[0]!.status).toBe("expiring");
    expect(report.results[0]!.canAutoRecover).toBe(true);
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
