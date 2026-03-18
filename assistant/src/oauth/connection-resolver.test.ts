import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockProvider: Record<string, unknown> | undefined;
let mockConnection: Record<string, unknown> | undefined;
let mockApp: Record<string, unknown> | undefined;
let mockAccessToken: string | undefined;
let mockConfig: Record<string, unknown> = {};
let mockManagedProxyCtx = {
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
};
let mockAssistantId = "";

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
  getConnectionByProvider: () => mockConnection,
  getConnectionByProviderAndAccount: () => mockConnection,
  getApp: () => mockApp,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => mockAccessToken,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
}));

mock.module("../config/env.js", () => ({
  getPlatformAssistantId: () => mockAssistantId,
}));

mock.module("../providers/managed-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => mockManagedProxyCtx,
}));

// ---------------------------------------------------------------------------
// Import the module under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { BYOOAuthConnection } from "./byo-connection.js";
import { resolveOAuthConnection } from "./connection-resolver.js";
import { PlatformOAuthConnection } from "./platform-connection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaults(): void {
  mockProvider = {
    providerKey: "integration:google",
    baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    managedServiceConfigKey: null,
  };
  mockConnection = {
    id: "conn-1",
    providerKey: "integration:google",
    oauthAppId: "app-1",
    accountInfo: "user@example.com",
    grantedScopes: JSON.stringify(["scope-a", "scope-b"]),
    status: "active",
  };
  mockApp = {
    id: "app-1",
    providerKey: "integration:google",
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
  mockManagedProxyCtx = {
    enabled: true,
    platformBaseUrl: "https://platform.example.com",
    assistantApiKey: "sk-test-key",
  };
  mockAssistantId = "asst-123";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveOAuthConnection", () => {
  beforeEach(() => {
    setupDefaults();
  });

  test("returns BYOOAuthConnection when provider has no managedServiceConfigKey", async () => {
    const result = await resolveOAuthConnection("integration:google");
    expect(result).toBeInstanceOf(BYOOAuthConnection);
    expect(result.id).toBe("conn-1");
    expect(result.providerKey).toBe("integration:google");
  });

  test("returns PlatformOAuthConnection when managed mode is active", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";

    const result = await resolveOAuthConnection("integration:google");
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
    expect(result.id).toBe("integration:google");
    expect(result.providerKey).toBe("integration:google");
    expect(result.accountInfo).toBeNull();
    expect(result.grantedScopes).toEqual([]);
  });

  test("passes accountInfo through to PlatformOAuthConnection", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";

    const result = await resolveOAuthConnection(
      "integration:google",
      "user@example.com",
    );
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
    expect(result.accountInfo).toBe("user@example.com");
  });

  test("returns BYOOAuthConnection when service config mode is your-own", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    (mockConfig.services as Record<string, unknown>)["google-oauth"] = {
      mode: "your-own",
    };

    const result = await resolveOAuthConnection("integration:google");
    expect(result).toBeInstanceOf(BYOOAuthConnection);
    expect(result.id).toBe("conn-1");
  });

  test("managed path does not require a local connection row", async () => {
    mockProvider!.managedServiceConfigKey = "google-oauth";
    mockConnection = undefined;
    mockAccessToken = undefined;

    const result = await resolveOAuthConnection("integration:google");
    expect(result).toBeInstanceOf(PlatformOAuthConnection);
  });
});
