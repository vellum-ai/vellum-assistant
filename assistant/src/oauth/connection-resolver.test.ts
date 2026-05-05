import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockProvider: Record<string, unknown> | undefined;
let mockConnection: Record<string, unknown> | undefined;
let mockAccessToken: string | undefined;
let mockConfig: Record<string, unknown> = {};
let mockPlatformClient: Record<string, unknown> | null = null;

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
  getActiveConnection: (
    _pk: string,
    opts?: { clientId?: string; account?: string },
  ) => {
    if (opts?.clientId && mockConnection?.clientId !== opts.clientId)
      return undefined;
    if (opts?.account && mockConnection?.accountInfo !== opts.account)
      return undefined;
    return mockConnection;
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
  mockPlatformClient = makeMockClient();
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
