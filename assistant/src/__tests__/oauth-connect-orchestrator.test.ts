import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Track calls to prepareOAuth2Flow and startOAuth2Flow
let lastPrepareArgs: { config: unknown; options: unknown } | null = null;
let lastStartArgs: {
  config: unknown;
  callbacks: unknown;
  options: unknown;
} | null = null;

let mockPrepareResult: {
  authorizeUrl: string;
  state: string;
  completion: Promise<{
    tokens: { accessToken: string; refreshToken?: string };
    grantedScopes: string[];
    rawTokenResponse: Record<string, unknown>;
  }>;
} = {
  authorizeUrl: "https://provider.example.com/authorize?prepared",
  state: "mock-state-123",
  completion: new Promise(() => {}), // never resolves by default
};

let mockStartResult: {
  tokens: { accessToken: string; refreshToken?: string };
  grantedScopes: string[];
  rawTokenResponse: Record<string, unknown>;
} = {
  tokens: { accessToken: "mock-access-token" },
  grantedScopes: ["read", "write"],
  rawTokenResponse: { access_token: "mock-access-token" },
};

mock.module("../security/oauth2.js", () => ({
  prepareOAuth2Flow: async (config: unknown, options: unknown) => {
    lastPrepareArgs = { config, options };
    return mockPrepareResult;
  },
  startOAuth2Flow: async (
    config: unknown,
    callbacks: unknown,
    options: unknown,
  ) => {
    lastStartArgs = { config, callbacks, options };
    return mockStartResult;
  },
}));

// Mock logger
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock identity verifier — returns a stable account identifier
let mockIdentityResult: string | undefined = "user@example.com";

mock.module("../oauth/identity-verifier.js", () => ({
  verifyIdentity: async () => mockIdentityResult,
}));

// Mock token persistence — just returns the accountInfo
mock.module("../oauth/token-persistence.js", () => ({
  storeOAuth2Tokens: async (params: { parsedAccountIdentifier?: string }) => ({
    accountInfo: params.parsedAccountIdentifier ?? undefined,
  }),
}));

// Mock scope policy — always approves
mock.module("../oauth/scope-policy.js", () => ({
  resolveScopes: (
    _profile: unknown,
    requestedScopes: string[] | undefined,
  ) => ({
    ok: true,
    scopes: requestedScopes ?? ["openid", "email"],
  }),
}));

// Provider store mock — configurable per test
type ProviderRow = {
  provider: string;
  authorizeUrl: string;
  tokenExchangeUrl: string;
  tokenEndpointAuthMethod: string | null;
  userinfoUrl: string | null;
  baseUrl: string | null;
  defaultScopes: string;
  scopePolicy: string;
  authorizeParams: string | null;
  pingUrl: string | null;
  pingMethod: string | null;
  pingHeaders: string | null;
  pingBody: string | null;
  managedServiceConfigKey: string | null;
  displayLabel: string | null;
  description: string | null;
  dashboardUrl: string | null;
  clientIdPlaceholder: string | null;
  requiresClientSecret: number;
  loopbackPort: number | null;
  injectionTemplates: string | null;
  appType: string | null;
  setupNotes: string | null;
  identityUrl: string | null;
  identityMethod: string | null;
  identityHeaders: string | null;
  identityBody: string | null;
  identityResponsePaths: string | null;
  identityFormat: string | null;
  identityOkField: string | null;
  featureFlag: string | null;
  createdAt: number;
  updatedAt: number;
};

let mockProviderStore: Record<string, ProviderRow> = {};

mock.module("../oauth/oauth-store.js", () => ({
  getProvider: (key: string) => mockProviderStore[key],
}));

// Config / ingress mocks — for gateway transport validation
let mockPublicBaseUrl = "";

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    ingress: { publicBaseUrl: mockPublicBaseUrl },
  }),
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getPublicBaseUrl: (config?: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config?.ingress?.publicBaseUrl ?? mockPublicBaseUrl;
    if (!url) {
      throw new Error("No public base URL configured.");
    }
    return url;
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are in place
// ---------------------------------------------------------------------------

import { orchestrateOAuthConnect } from "../oauth/connect-orchestrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProviderRow(
  overrides: Partial<ProviderRow> & { provider: string },
): ProviderRow {
  const now = Date.now();
  return {
    authorizeUrl: "https://provider.example.com/authorize",
    tokenExchangeUrl: "https://provider.example.com/token",
    tokenEndpointAuthMethod: null,
    userinfoUrl: null,
    baseUrl: null,
    defaultScopes: '["openid","email"]',
    scopePolicy:
      '{"allowAdditionalScopes":false,"allowedOptionalScopes":[],"forbiddenScopes":[]}',
    authorizeParams: null,
    pingUrl: null,
    pingMethod: null,
    pingHeaders: null,
    pingBody: null,
    managedServiceConfigKey: null,
    displayLabel: null,
    description: null,
    dashboardUrl: null,
    clientIdPlaceholder: null,
    requiresClientSecret: 1,
    loopbackPort: null,
    injectionTemplates: null,
    appType: null,
    setupNotes: null,
    identityUrl: null,
    identityMethod: null,
    identityHeaders: null,
    identityBody: null,
    identityResponsePaths: null,
    identityFormat: null,
    identityOkField: null,
    featureFlag: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// Shared provider definitions used across tests
const GOOGLE_PROVIDER = makeProviderRow({
  provider: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenExchangeUrl: "https://oauth2.googleapis.com/token",
  loopbackPort: 17332,
  displayLabel: "Google",
});

const OUTLOOK_PROVIDER = makeProviderRow({
  provider: "outlook",
  authorizeUrl:
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenExchangeUrl:
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  loopbackPort: 17334,
  displayLabel: "Outlook",
});

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastPrepareArgs = null;
  lastStartArgs = null;
  mockPublicBaseUrl = "";
  mockIdentityResult = "user@example.com";
  mockProviderStore = {};

  mockPrepareResult = {
    authorizeUrl: "https://provider.example.com/authorize?prepared",
    state: "mock-state-123",
    completion: new Promise(() => {}),
  };

  mockStartResult = {
    tokens: { accessToken: "mock-access-token" },
    grantedScopes: ["read", "write"],
    rawTokenResponse: { access_token: "mock-access-token" },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orchestrateOAuthConnect — transport selection", () => {
  // -------------------------------------------------------------------------
  // Deferred (non-interactive) path
  // -------------------------------------------------------------------------

  describe("deferred (non-interactive) flow", () => {
    test('callbackTransport: "loopback" → passes loopback options to prepareOAuth2Flow', async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "loopback",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.deferred).toBe(true);

      // Verify prepareOAuth2Flow received loopback options
      expect(lastPrepareArgs).not.toBeNull();
      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });

    test('callbackTransport: "gateway" → passes gateway options to prepareOAuth2Flow', async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;
      mockPublicBaseUrl = "https://gw.example.com";

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "gateway",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.deferred).toBe(true);

      expect(lastPrepareArgs).not.toBeNull();
      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "gateway",
      });
    });

    test("callbackTransport omitted → defaults to loopback", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        // callbackTransport intentionally omitted
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.deferred).toBe(true);

      expect(lastPrepareArgs).not.toBeNull();
      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });

    test("gateway without ingress configured → returns error", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;
      mockPublicBaseUrl = ""; // no ingress

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "gateway",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("public ingress URL");
    });

    test("loopback without ingress configured → succeeds", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;
      mockPublicBaseUrl = ""; // no ingress

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "loopback",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.deferred).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Interactive path
  // -------------------------------------------------------------------------

  describe("interactive flow", () => {
    test('callbackTransport: "loopback" → passes loopback options to startOAuth2Flow', async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: true,
        callbackTransport: "loopback",
        openUrl: () => {},
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.deferred).toBe(false);

      expect(lastStartArgs).not.toBeNull();
      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });

    test('callbackTransport: "gateway" → passes gateway options to startOAuth2Flow', async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: true,
        callbackTransport: "gateway",
        openUrl: () => {},
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.deferred).toBe(false);

      expect(lastStartArgs).not.toBeNull();
      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "gateway",
      });
    });

    test("callbackTransport omitted → defaults to loopback", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: true,
        openUrl: () => {},
        // callbackTransport intentionally omitted
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.deferred).toBe(false);

      expect(lastStartArgs).not.toBeNull();
      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Provider x transport matrix — verifies the rule is universal
  // -------------------------------------------------------------------------

  describe("provider x transport matrix", () => {
    test("Google + loopback → loopback transport with Google loopbackPort", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "loopback",
      });

      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });

    test("Google + gateway → gateway transport", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;
      mockPublicBaseUrl = "https://gw.example.com";

      await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "gateway",
      });

      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "gateway",
      });
    });

    test("Outlook + loopback → loopback transport with Outlook loopbackPort", async () => {
      mockProviderStore["outlook"] = OUTLOOK_PROVIDER;

      await orchestrateOAuthConnect({
        service: "outlook",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "loopback",
      });

      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17334,
      });
    });

    test("Outlook + gateway → gateway transport", async () => {
      mockProviderStore["outlook"] = OUTLOOK_PROVIDER;
      mockPublicBaseUrl = "https://gw.example.com";

      await orchestrateOAuthConnect({
        service: "outlook",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "gateway",
      });

      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "gateway",
      });
    });

    test("Google + loopback (interactive) → loopback transport", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: true,
        callbackTransport: "loopback",
        openUrl: () => {},
      });

      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });

    test("Google + gateway (interactive) → gateway transport", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: true,
        callbackTransport: "gateway",
        openUrl: () => {},
      });

      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "gateway",
      });
    });

    test("Outlook + loopback (interactive) → loopback transport with Outlook loopbackPort", async () => {
      mockProviderStore["outlook"] = OUTLOOK_PROVIDER;

      await orchestrateOAuthConnect({
        service: "outlook",
        clientId: "client-id",
        isInteractive: true,
        callbackTransport: "loopback",
        openUrl: () => {},
      });

      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17334,
      });
    });

    test("Outlook + gateway (interactive) → gateway transport", async () => {
      mockProviderStore["outlook"] = OUTLOOK_PROVIDER;

      await orchestrateOAuthConnect({
        service: "outlook",
        clientId: "client-id",
        isInteractive: true,
        callbackTransport: "gateway",
        openUrl: () => {},
      });

      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "gateway",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility
  // -------------------------------------------------------------------------

  describe("backward compatibility", () => {
    test("missing callbackTransport defaults to loopback (deferred, Google)", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
      });

      expect(result.success).toBe(true);
      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });

    test("missing callbackTransport defaults to loopback (deferred, Outlook)", async () => {
      mockProviderStore["outlook"] = OUTLOOK_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "outlook",
        clientId: "client-id",
        isInteractive: false,
      });

      expect(result.success).toBe(true);
      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17334,
      });
    });

    test("missing callbackTransport defaults to loopback (interactive, Google)", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: true,
        openUrl: () => {},
      });

      expect(result.success).toBe(true);
      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17332,
      });
    });

    test("missing callbackTransport defaults to loopback (interactive, Outlook)", async () => {
      mockProviderStore["outlook"] = OUTLOOK_PROVIDER;

      const result = await orchestrateOAuthConnect({
        service: "outlook",
        clientId: "client-id",
        isInteractive: true,
        openUrl: () => {},
      });

      expect(result.success).toBe(true);
      expect(lastStartArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: 17334,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  describe("error cases", () => {
    test("gateway without ingress (deferred, Google) → returns error", async () => {
      mockProviderStore["google"] = GOOGLE_PROVIDER;
      mockPublicBaseUrl = "";

      const result = await orchestrateOAuthConnect({
        service: "google",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "gateway",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("public ingress URL");
      // prepareOAuth2Flow should NOT have been called
      expect(lastPrepareArgs).toBeNull();
    });

    test("gateway without ingress (deferred, Outlook) → returns error", async () => {
      mockProviderStore["outlook"] = OUTLOOK_PROVIDER;
      mockPublicBaseUrl = "";

      const result = await orchestrateOAuthConnect({
        service: "outlook",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "gateway",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("public ingress URL");
      expect(lastPrepareArgs).toBeNull();
    });

    test("unknown provider → returns error", async () => {
      // No provider registered in the mock store

      const result = await orchestrateOAuthConnect({
        service: "unknown-provider",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "loopback",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("No OAuth provider registered");
      expect(result.error).toContain("unknown-provider");
    });
  });

  // -------------------------------------------------------------------------
  // Provider without loopbackPort
  // -------------------------------------------------------------------------

  describe("provider without loopbackPort", () => {
    test("loopback transport passes undefined loopbackPort when provider has none", async () => {
      mockProviderStore["custom"] = makeProviderRow({
        provider: "custom",
        loopbackPort: null, // no fixed port
      });

      await orchestrateOAuthConnect({
        service: "custom",
        clientId: "client-id",
        isInteractive: false,
        callbackTransport: "loopback",
      });

      expect(lastPrepareArgs!.options).toEqual({
        callbackTransport: "loopback",
        loopbackPort: undefined,
      });
    });
  });
});
