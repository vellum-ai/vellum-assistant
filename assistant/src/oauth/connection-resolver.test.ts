import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockProvider: Record<string, unknown> | undefined;
let mockConnection: Record<string, unknown> | undefined;
let mockConnections:
  | Array<Record<string, unknown> & { clientId?: string; accountInfo?: string }>
  | undefined;
let mockAccessToken: string | undefined;
let mockConfig: Record<string, unknown> = {};
let mockPlatformClient: Record<string, unknown> | null = null;
let syncManualTokenCalls: string[] = [];

// ---------------------------------------------------------------------------
// Module mocks (must precede imports of the module under test)
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("./oauth-store.js", () => ({
  getProvider: () => mockProvider,
  getActiveConnections: (
    _pk: string,
    opts?: { clientId?: string; account?: string },
  ) => {
    // Default to the single mockConnection unless a test sets an explicit list.
    const rows = mockConnections ?? (mockConnection ? [mockConnection] : []);
    return rows.filter((row) => {
      if (opts?.clientId && row.clientId !== opts.clientId) return false;
      if (opts?.account && row.accountInfo !== opts.account) return false;
      return true;
    });
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => mockAccessToken,
}));

mock.module("./credential-token-resolver.js", () => ({
  getConnectionAccessTokenResult: async () => ({
    value: mockAccessToken,
    unreachable: false,
    key: "mock-key",
  }),
}));

mock.module("./manual-token-connection.js", () => ({
  syncManualTokenConnection: async (provider: string) => {
    syncManualTokenCalls.push(provider);
    if (provider === "telegram" && mockConnection?.provider === "telegram") {
      mockConnection.accountInfo = "@example_bot";
    }
  },
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
}));

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockPlatformClient,
  },
}));

// ---------------------------------------------------------------------------
// Import the module under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { BYOOAuthConnection } from "./byo-connection.js";
import {
  resolveEffectiveBaseUrl,
  resolveOAuthConnection,
  resolveOAuthConnectionWithMeta,
} from "./connection-resolver.js";
import { PlatformOAuthConnection } from "./platform-connection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockClient() {
  return {
    baseUrl: "https://platform.example.com",
    assistantApiKey: "sk-test-key",
    platformAssistantId: "asst-123",
    fetch: mock(async () => {
      return new Response(
        JSON.stringify({
          results: [{ id: "platform-conn-1", account_label: null }],
        }),
        { status: 200 },
      );
    }),
  };
}

function setupDefaults(): void {
  mockProvider = {
    provider: "google",
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    managedServiceConfigKey: null,
  };
  mockConnection = {
    id: "conn-1",
    provider: "google",
    oauthAppId: "app-1",
    accountInfo: "user@example.com",
    grantedScopes: JSON.stringify(["scope-a", "scope-b"]),
    status: "active",
    clientId: "client-1",
  };
  mockAccessToken = "tok-valid";
  mockConfig = {
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
      "google-oauth": { mode: "managed" },
    },
  };
  mockConnections = undefined;
  mockPlatformClient = makeMockClient();
  syncManualTokenCalls = [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveOAuthConnection", () => {
  beforeEach(() => {
    setupDefaults();
  });

  test("returns BYOOAuthConnection when provider has no managedServiceConfigKey", async () => {
    const result = await resolveOAuthConnection("google");
    expect(result).toBeInstanceOf(BYOOAuthConnection);
    expect(result.id).toBe("conn-1");
    expect(result.provider).toBe("google");
  });

  test("returns PlatformOAuthConnection when managed mode is active", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";

    const result = await resolveOAuthConnection("google");
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
    expect(result.id).toBe("google");
    expect(result.provider).toBe("google");
    expect(result.accountInfo).toBeNull();
  });

  test("passes account through to PlatformOAuthConnection", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";

    const result = await resolveOAuthConnection("google", {
      account: "user@example.com",
    });
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
    expect(result.accountInfo).toBe("user@example.com");
  });

  test("managed path falls back to displayed account label when account_identifier does not match", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    const fetchPaths: string[] = [];
    mockPlatformClient = {
      ...makeMockClient(),
      fetch: mock(async (path: string) => {
        fetchPaths.push(path);
        if (path.includes("account_identifier=alice%40example.com")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "platform-conn-1",
                account_label: "alice@example.com",
              },
            ],
          }),
          { status: 200 },
        );
      }),
    };

    const result = await resolveOAuthConnection("google", {
      account: "alice@example.com",
    });

    expect(result).toBeInstanceOf(PlatformOAuthConnection);
    expect(result.accountInfo).toBe("alice@example.com");
    expect(fetchPaths).toEqual([
      "/v1/assistants/asst-123/oauth/connections/?provider=google&status=ACTIVE&account_identifier=alice%40example.com",
      "/v1/assistants/asst-123/oauth/connections/?provider=google&status=ACTIVE",
    ]);
  });

  test("returns PlatformOAuthConnection when GitHub is in managed mode", async () => {
    mockProvider!.provider = "github";
    mockProvider!.managedServiceConfigKey = "github-oauth";
    (mockConfig.services as Record<string, unknown>)["github-oauth"] = {
      mode: "managed",
    };

    const result = await resolveOAuthConnection("github");
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
    expect(result.id).toBe("github");
    expect(result.provider).toBe("github");
  });

  test("returns BYOOAuthConnection when service config mode is your-own", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    (mockConfig.services as Record<string, unknown>)["google-oauth"] = {
      mode: "your-own",
    };

    const result = await resolveOAuthConnection("google");
    expect(result).toBeInstanceOf(BYOOAuthConnection);
    expect(result.id).toBe("conn-1");
  });

  test("managed path does not require a local connection row", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    mockConnection = undefined;
    mockAccessToken = undefined;

    const result = await resolveOAuthConnection("google");
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
  });

  test("managed path ignores clientId option", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";

    const result = await resolveOAuthConnection("google", {
      clientId: "some-client-id",
    });
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
  });

  test("BYO path narrows by clientId when provided", async () => {
    const result = await resolveOAuthConnection("google", {
      clientId: "client-1",
    });
    expect(result).toBeInstanceOf(BYOOAuthConnection);
    expect(result.id).toBe("conn-1");
  });

  test("BYO path returns no credential when clientId does not match", async () => {
    await expect(
      resolveOAuthConnection("google", {
        clientId: "wrong-client",
      }),
    ).rejects.toThrow(/No active OAuth connection found/);
  });

  test("BYO path reconciles manual-token providers before exact account lookup", async () => {
    mockProvider = {
      provider: "telegram",
      baseUrl: "https://api.telegram.org",
      authorizeUrl: "urn:manual-token",
      managedServiceConfigKey: null,
    };
    mockConnection = {
      id: "conn-telegram",
      provider: "telegram",
      oauthAppId: "app-telegram",
      accountInfo: null,
      grantedScopes: JSON.stringify([]),
      status: "active",
      clientId: "manual-config",
    };
    mockAccessToken = "telegram-test-token";

    const result = await resolveOAuthConnection("telegram", {
      account: "@example_bot",
    });

    expect(syncManualTokenCalls).toEqual(["telegram"]);
    expect(mockConnection.accountInfo).toBe("@example_bot");
    expect(result).toBeInstanceOf(BYOOAuthConnection);
    expect(result.id).toBe("conn-telegram");
  });
});

describe("resolveOAuthConnection scope-awareness", () => {
  const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
  const GMAIL_FULL_ACCESS_SCOPE = "https://mail.google.com/";
  const CALENDAR_ONLY = [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
  ];
  const FULL_BUNDLE = [GMAIL_SCOPE, ...CALENDAR_ONLY];

  function clientReturning(results: unknown[]) {
    return {
      ...makeMockClient(),
      fetch: mock(
        async () => new Response(JSON.stringify({ results }), { status: 200 }),
      ),
    };
  }

  beforeEach(() => {
    setupDefaults();
    mockProvider!.managedServiceConfigKey = "google-oauth";
  });

  test("managed: rejects a Calendar-only connection when Gmail scope is required", async () => {
    mockPlatformClient = clientReturning([
      { id: "cal-only", account_label: null, scopes_granted: CALENDAR_ONLY },
    ]);

    await expect(
      resolveOAuthConnection("google", { requiredScopes: [GMAIL_SCOPE] }),
    ).rejects.toThrow(/missing required access.*gmail\.readonly/s);
  });

  test("managed: resolves when a connection carries the required Gmail scope", async () => {
    mockPlatformClient = clientReturning([
      { id: "full", account_label: null, scopes_granted: FULL_BUNDLE },
    ]);

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
  });

  test("managed: treats full Gmail access as covering Gmail read access", async () => {
    mockPlatformClient = clientReturning([
      {
        id: "full-gmail-access",
        account_label: null,
        scopes_granted: [GMAIL_FULL_ACCESS_SCOPE],
      },
    ]);

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
  });

  test("managed: unknown scope data never blocks (back-compat)", async () => {
    // Older connections report no scopes_granted — must not be rejected.
    mockPlatformClient = clientReturning([
      { id: "legacy", account_label: null },
    ]);

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
  });

  test("managed: prefers a scope-satisfying connection over a narrow one", async () => {
    const fullClient = clientReturning([
      { id: "cal-only", account_label: null, scopes_granted: CALENDAR_ONLY },
      { id: "full", account_label: null, scopes_granted: FULL_BUNDLE },
    ]);
    mockPlatformClient = fullClient;

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
    // PlatformOAuthConnection is keyed by provider, so assert resolution
    // succeeded (it would have thrown if only the narrow connection matched).
    expect(result.provider).toBe("google");
  });

  test("managed: no requiredScopes preserves prior behavior", async () => {
    mockPlatformClient = clientReturning([
      { id: "cal-only", account_label: null, scopes_granted: CALENDAR_ONLY },
    ]);

    const result = await resolveOAuthConnection("google");
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
  });

  test("BYO: rejects when granted scopes are known and missing the requirement", async () => {
    (mockConfig.services as Record<string, unknown>)["google-oauth"] = {
      mode: "your-own",
    };
    mockConnection!.grantedScopes = JSON.stringify(CALENDAR_ONLY);

    await expect(
      resolveOAuthConnection("google", { requiredScopes: [GMAIL_SCOPE] }),
    ).rejects.toThrow(/missing required access/);
  });

  test("BYO: treats full Gmail access as covering Gmail read access", async () => {
    (mockConfig.services as Record<string, unknown>)["google-oauth"] = {
      mode: "your-own",
    };
    mockConnection!.grantedScopes = JSON.stringify([GMAIL_FULL_ACCESS_SCOPE]);

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(BYOOAuthConnection);
  });

  test("BYO: unknown granted scopes never block", async () => {
    (mockConfig.services as Record<string, unknown>)["google-oauth"] = {
      mode: "your-own",
    };
    mockConnection!.grantedScopes = JSON.stringify([]);

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(BYOOAuthConnection);
  });

  test("BYO: picks an older scope-satisfying connection over a newer narrow one", async () => {
    (mockConfig.services as Record<string, unknown>)["google-oauth"] = {
      mode: "your-own",
    };
    // Newest first (matching the store's ordering): a Calendar-only row, then
    // an older row that carries the Gmail scope. The narrow row must not win.
    mockConnections = [
      {
        id: "cal-only",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify(CALENDAR_ONLY),
        status: "active",
      },
      {
        id: "full",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify(FULL_BUNDLE),
        status: "active",
      },
    ];

    const result = await resolveOAuthConnection("google", {
      requiredScopes: [GMAIL_SCOPE],
    });
    expect(result).toBeInstanceOf(BYOOAuthConnection);
    expect(result.id).toBe("full");
  });
});

describe("resolveOAuthConnectionWithMeta multi-account visibility", () => {
  function clientReturning(results: unknown[]) {
    return {
      ...makeMockClient(),
      fetch: mock(
        async () => new Response(JSON.stringify({ results }), { status: 200 }),
      ),
    };
  }

  beforeEach(() => {
    setupDefaults();
  });

  test("managed: multiple connections + no account surfaces ambiguity and the selected label", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    mockPlatformClient = clientReturning([
      { id: "conn-personal", account_label: "user@example.com" },
      { id: "conn-work", account_label: "work@example.com" },
    ]);

    const { connection, ambiguous, allAccounts } =
      await resolveOAuthConnectionWithMeta("google");

    expect(ambiguous).toBe(true);
    expect(allAccounts).toEqual(["user@example.com", "work@example.com"]);
    // The most-recently-created connection (first) serves the request.
    expect(connection.accountInfo).toBe("user@example.com");
  });

  test("managed: account passed disambiguates and clears the warning", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    mockPlatformClient = clientReturning([
      { id: "conn-work", account_label: "work@example.com" },
    ]);

    const { ambiguous } = await resolveOAuthConnectionWithMeta("google", {
      account: "work@example.com",
    });

    expect(ambiguous).toBe(false);
  });

  test("managed: single connection is never ambiguous", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    mockPlatformClient = clientReturning([
      { id: "conn-only", account_label: "user@example.com" },
    ]);

    const { ambiguous, allAccounts } =
      await resolveOAuthConnectionWithMeta("google");

    expect(ambiguous).toBe(false);
    expect(allAccounts).toEqual(["user@example.com"]);
  });

  test("BYO: multiple connections + no account surfaces ambiguity and the selected label", async () => {
    mockConnections = [
      {
        id: "conn-personal",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
      {
        id: "conn-work",
        provider: "google",
        accountInfo: "work@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
    ];

    const { connection, ambiguous, allAccounts } =
      await resolveOAuthConnectionWithMeta("google");

    expect(ambiguous).toBe(true);
    expect(allAccounts).toEqual(["user@example.com", "work@example.com"]);
    expect(connection).toBeInstanceOf(BYOOAuthConnection);
    expect(connection.id).toBe("conn-personal");
    expect(connection.accountInfo).toBe("user@example.com");
  });

  test("BYO: account passed disambiguates and clears the warning", async () => {
    mockConnections = [
      {
        id: "conn-work",
        provider: "google",
        accountInfo: "work@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
    ];

    const { ambiguous, connection } = await resolveOAuthConnectionWithMeta(
      "google",
      { account: "work@example.com" },
    );

    expect(ambiguous).toBe(false);
    expect(connection.id).toBe("conn-work");
  });

  test("BYO: single connection is never ambiguous", async () => {
    const { ambiguous, allAccounts } =
      await resolveOAuthConnectionWithMeta("google");

    expect(ambiguous).toBe(false);
    expect(allAccounts).toEqual(["user@example.com"]);
  });
});

describe("resolveOAuthConnection account-mismatch error listing", () => {
  function clientReturning(results: unknown[]) {
    return {
      ...makeMockClient(),
      fetch: mock(
        async () => new Response(JSON.stringify({ results }), { status: 200 }),
      ),
    };
  }

  beforeEach(() => {
    setupDefaults();
  });

  test("managed: account mismatch lists other active connections", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    mockPlatformClient = {
      ...makeMockClient(),
      fetch: mock(async (path: string) => {
        // The account-identifier-filtered lookup matches nothing…
        if (path.includes("account_identifier=")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        // …but the provider still has active connections.
        return new Response(
          JSON.stringify({
            results: [
              { id: "conn-1", account_label: "user@example.com" },
              { id: "conn-2", account_label: "alice@example.org" },
            ],
          }),
          { status: 200 },
        );
      }),
    };

    await expect(
      resolveOAuthConnection("google", { account: "typo@example.com" }),
    ).rejects.toThrow(
      'No active OAuth connection found for provider "google" with account ' +
        '"typo@example.com". Active google connections: user@example.com, ' +
        "alice@example.org.",
    );
  });

  test("managed: zero connections keeps the connect-me message", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    mockPlatformClient = clientReturning([]);

    await expect(
      resolveOAuthConnection("google", { account: "typo@example.com" }),
    ).rejects.toThrow(
      'No active OAuth connection found for provider "google" with account ' +
        '"typo@example.com". The google service needs to be connected.',
    );
  });

  test("BYO: account mismatch lists other active connections", async () => {
    mockConnections = [
      {
        id: "conn-personal",
        provider: "google",
        accountInfo: "user@example.com",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
      {
        id: "conn-work",
        provider: "google",
        accountInfo: "alice@example.org",
        grantedScopes: JSON.stringify([]),
        status: "active",
      },
    ];

    await expect(
      resolveOAuthConnection("google", { account: "typo@example.com" }),
    ).rejects.toThrow(
      'No active OAuth connection found for "google" matching account ' +
        '"typo@example.com". Active google connections: user@example.com, ' +
        "alice@example.org.",
    );
  });

  test("BYO: zero connections keeps the connect-me message", async () => {
    mockConnection = undefined;
    mockConnections = [];

    await expect(
      resolveOAuthConnection("google", { account: "typo@example.com" }),
    ).rejects.toThrow(
      'No active OAuth connection found for "google" matching account ' +
        '"typo@example.com". The google service needs to be connected before ' +
        "it can be used.",
    );
  });
});

describe("resolveEffectiveBaseUrl", () => {
  const fallback = "https://login.salesforce.com";

  test("uses instance_url from JSON-string metadata for Salesforce", () => {
    const metadata = JSON.stringify({
      instance_url: "https://acme.my.salesforce.com",
      issued_at: "1714000000000",
    });
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      "https://acme.my.salesforce.com",
    );
  });

  test("uses instance_url from already-parsed object metadata", () => {
    const metadata = { instance_url: "https://na162.salesforce.com" };
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      "https://na162.salesforce.com",
    );
  });

  test("falls back to seed baseUrl when metadata is null", () => {
    expect(resolveEffectiveBaseUrl("salesforce", fallback, null)).toBe(
      fallback,
    );
  });

  test("falls back to seed baseUrl when instance_url is empty string", () => {
    const metadata = JSON.stringify({ instance_url: "" });
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      fallback,
    );
  });

  test("falls back to seed baseUrl when metadata is unparseable JSON", () => {
    expect(
      resolveEffectiveBaseUrl("salesforce", fallback, "{ not valid json"),
    ).toBe(fallback);
  });

  test("falls back to seed baseUrl when instance_url is the wrong type", () => {
    const metadata = JSON.stringify({ instance_url: 12345 });
    expect(resolveEffectiveBaseUrl("salesforce", fallback, metadata)).toBe(
      fallback,
    );
  });

  test("ignores instance_url for non-Salesforce providers", () => {
    // A different provider whose token response happens to include an
    // instance_url-shaped field MUST NOT have its baseUrl rewritten.
    const metadata = JSON.stringify({
      instance_url: "https://attacker.example.com",
    });
    expect(
      resolveEffectiveBaseUrl(
        "google",
        "https://gmail.googleapis.com/gmail/v1/users/me",
        metadata,
      ),
    ).toBe("https://gmail.googleapis.com/gmail/v1/users/me");
  });
});
