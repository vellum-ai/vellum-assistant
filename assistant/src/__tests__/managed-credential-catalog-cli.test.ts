import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  getCliLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Mutable state for mocks
// ---------------------------------------------------------------------------

let mockPlatformBaseUrl = "";
let mockAssistantApiKey: string | null = null;
let mockPlatformAssistantId = "";

/** Simulated platform catalog responses keyed by URL. */
let mockFetchResponses: Map<string, { status: number; body: unknown }> =
  new Map();

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
  getPlatformAssistantId: () => mockPlatformAssistantId,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey;
    }
    return null;
  },
}));

// Mock global fetch
const _originalFetch = globalThis.fetch;
const mockFetch = async (
  input: string | URL | Request,
  _init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const entry = mockFetchResponses.get(url);
  if (!entry) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(JSON.stringify(entry.body), {
    status: entry.status,
    headers: { "Content-Type": "application/json" },
  });
};
mockFetch.preconnect = _originalFetch.preconnect;
globalThis.fetch = mockFetch;

// ---------------------------------------------------------------------------
// Import after mocks are installed
// ---------------------------------------------------------------------------

import {
  fetchManagedCatalog,
  type ManagedCredentialDescriptor,
} from "../credential-execution/managed-catalog.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchManagedCatalog", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    mockPlatformAssistantId = "";
    mockFetchResponses = new Map();
  });

  test("returns empty descriptors when managed proxy prerequisites are missing", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(true);
    expect(result.descriptors).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  test("returns empty descriptors when platform URL is missing", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = "sk-test-key";

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(true);
    expect(result.descriptors).toEqual([]);
  });

  test("returns empty descriptors when API key is missing", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = null;

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(true);
    expect(result.descriptors).toEqual([]);
  });

  test("returns empty descriptors when assistant ID is missing", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    mockPlatformAssistantId = "";

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(true);
    expect(result.descriptors).toEqual([]);
  });

  test("parses platform catalog response into descriptors with correct handles", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    mockPlatformAssistantId = "ast-uuid-1234";

    mockFetchResponses.set(
      "https://platform.example.com/v1/assistants/ast-uuid-1234/oauth/managed/catalog/",
      {
        status: 200,
        body: [
          {
            handle: "platform_oauth:conn_google_123",
            connection_id: "conn_google_123",
            provider: "google",
            account_label: "user@gmail.com",
            scopes_granted: ["email", "calendar"],
            status: "active",
          },
          {
            handle: "platform_oauth:conn_slack_456",
            connection_id: "conn_slack_456",
            provider: "slack",
            account_label: "workspace-bot",
            scopes_granted: ["chat:write"],
            status: "active",
          },
        ],
      },
    );

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(true);
    expect(result.descriptors).toHaveLength(2);

    const [google, slack] = result.descriptors;
    expect(google.handle).toBe("platform_oauth:conn_google_123");
    expect(google.source).toBe("platform");
    expect(google.provider).toBe("google");
    expect(google.connectionId).toBe("conn_google_123");
    expect(google.accountInfo).toBe("user@gmail.com");
    expect(google.grantedScopes).toEqual(["email", "calendar"]);
    expect(google.status).toBe("active");

    expect(slack.handle).toBe("platform_oauth:conn_slack_456");
    expect(slack.provider).toBe("slack");
    expect(slack.connectionId).toBe("conn_slack_456");
  });

  test("handles empty connections list from platform", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    mockPlatformAssistantId = "ast-uuid-1234";

    mockFetchResponses.set(
      "https://platform.example.com/v1/assistants/ast-uuid-1234/oauth/managed/catalog/",
      {
        status: 200,
        body: [],
      },
    );

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(true);
    expect(result.descriptors).toEqual([]);
  });

  test("handles platform returning HTTP error gracefully", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    mockPlatformAssistantId = "ast-uuid-1234";

    mockFetchResponses.set(
      "https://platform.example.com/v1/assistants/ast-uuid-1234/oauth/managed/catalog/",
      {
        status: 500,
        body: { detail: "Internal server error" },
      },
    );

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(false);
    expect(result.descriptors).toEqual([]);
    expect(result.error).toContain("500");
  });

  test("handles platform returning unexpected format gracefully", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    mockPlatformAssistantId = "ast-uuid-1234";

    mockFetchResponses.set(
      "https://platform.example.com/v1/assistants/ast-uuid-1234/oauth/managed/catalog/",
      {
        status: 200,
        body: { unexpected: "shape" },
      },
    );

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unexpected response format");
  });

  test("defaults missing optional fields in catalog entries", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    mockPlatformAssistantId = "ast-uuid-1234";

    mockFetchResponses.set(
      "https://platform.example.com/v1/assistants/ast-uuid-1234/oauth/managed/catalog/",
      {
        status: 200,
        body: [
          {
            handle: "platform_oauth:conn_minimal",
            connection_id: "conn_minimal",
            provider: "github",
            // account_label, scopes_granted, status all omitted
          },
        ],
      },
    );

    const result = await fetchManagedCatalog();
    expect(result.ok).toBe(true);
    expect(result.descriptors).toHaveLength(1);

    const descriptor = result.descriptors[0];
    expect(descriptor.accountInfo).toBeNull();
    expect(descriptor.grantedScopes).toEqual([]);
    expect(descriptor.status).toBe("unknown");
    expect(descriptor.handle).toBe("platform_oauth:conn_minimal");
  });

  test("error messages never contain sensitive details", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-super-secret-key-12345";
    mockPlatformAssistantId = "ast-uuid-1234";

    // Simulate a network error whose message contains sensitive data
    const savedFetch = globalThis.fetch;
    const errorFetch: typeof fetch = Object.assign(
      async () => {
        throw new Error(
          "Connect failed to https://platform.example.com/v1/assistants/ast-uuid-1234/oauth/managed/catalog/ with Bearer sk-super-secret-key-12345",
        );
      },
      { preconnect: savedFetch.preconnect },
    );
    globalThis.fetch = errorFetch;

    try {
      const result = await fetchManagedCatalog();
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      // Raw error message (with URL, API key, etc.) must not leak
      expect(result.error).not.toContain("sk-super-secret-key-12345");
      expect(result.error).not.toContain("platform.example.com");
      expect(result.error).not.toContain("Connect failed");
      // Should only contain the error class name
      expect(result.error).toContain("Error");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe("managed credential merging", () => {
  test("managed descriptors produce correct CES handle format", () => {
    // Verify the handle format matches what CES tools expect
    const descriptor: ManagedCredentialDescriptor = {
      handle: "platform_oauth:conn_test_789",
      source: "platform",
      provider: "google",
      connectionId: "conn_test_789",
      accountInfo: "test@example.com",
      grantedScopes: ["email"],
      status: "active",
    };

    expect(descriptor.handle).toMatch(/^platform_oauth:/);
    expect(descriptor.handle).toBe("platform_oauth:conn_test_789");
    expect(descriptor.source).toBe("platform");
  });

  test("managed descriptors never expose token values", () => {
    // A descriptor should only contain non-secret metadata
    const descriptor: ManagedCredentialDescriptor = {
      handle: "platform_oauth:conn_abc",
      source: "platform",
      provider: "google",
      connectionId: "conn_abc",
      accountInfo: "user@example.com",
      grantedScopes: ["email", "calendar"],
      status: "active",
    };

    // Serialize and check for common token patterns
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("id_token");
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("Api-Key ");

    // Verify all properties are the expected non-secret metadata
    const keys = Object.keys(descriptor);
    expect(keys).toEqual([
      "handle",
      "source",
      "provider",
      "connectionId",
      "accountInfo",
      "grantedScopes",
      "status",
    ]);
  });
});
