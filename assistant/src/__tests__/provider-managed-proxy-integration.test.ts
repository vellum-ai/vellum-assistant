import { beforeEach, describe, expect, mock, test } from "bun:test";

import { MANAGED_PROVIDER_META } from "../providers/managed-proxy/constants.js";

// ---------------------------------------------------------------------------
// Mock the underlying dependencies that the real context module relies on.
// This avoids mocking the context module directly and prevents mock conflicts
// with context.test.ts (which also mocks these same underlying deps).
// ---------------------------------------------------------------------------
let mockPlatformBaseUrl = "";
let mockAssistantApiKey: string | null = null;

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => {
    if (key === "credential:vellum:assistant_api_key") {
      return mockAssistantApiKey;
    }
    return null;
  },
}));

import { initializeProviders, listProviders } from "../providers/registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM_BASE = "https://platform.example.com";
const MANAGED_API_KEY = "ast-managed-key-123";

const MANAGED_PROVIDERS: string[] = [
  "openai",
  "anthropic",
  "gemini",
  "fireworks",
  "openrouter",
];

function enableManagedProxy() {
  mockPlatformBaseUrl = PLATFORM_BASE;
  mockAssistantApiKey = MANAGED_API_KEY;
}

function disableManagedProxy() {
  mockPlatformBaseUrl = "";
  mockAssistantApiKey = null;
}

/**
 * Build an apiKeys record with a user key for every provider in `names`.
 */
function userKeysFor(...names: string[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const n of names) {
    keys[n] = `user-key-${n}`;
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  disableManagedProxy();
});

describe("managed proxy integration — credential precedence", () => {
  describe("user keys present → providers use direct connections (not proxy)", () => {
    test.each(MANAGED_PROVIDERS)(
      "%s registers when user key is provided regardless of managed context",
      (provider: string) => {
        enableManagedProxy();
        initializeProviders({
          apiKeys: userKeysFor(provider),
          provider,
          model: "test-model",
        });
        expect(listProviders()).toContain(provider);
      },
    );

    test("all five managed providers register with user keys", () => {
      enableManagedProxy();
      initializeProviders({
        apiKeys: userKeysFor(...MANAGED_PROVIDERS),
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      for (const p of MANAGED_PROVIDERS) {
        expect(registered).toContain(p);
      }
    });

    test("user keys still work when managed context is disabled", () => {
      disableManagedProxy();
      initializeProviders({
        apiKeys: userKeysFor(...MANAGED_PROVIDERS),
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      for (const p of MANAGED_PROVIDERS) {
        expect(registered).toContain(p);
      }
    });
  });

  describe("user keys absent + managed context available → providers use managed proxy", () => {
    test.each(MANAGED_PROVIDERS)(
      "%s registers via managed fallback when no user key",
      (provider: string) => {
        enableManagedProxy();
        initializeProviders({
          apiKeys: {},
          // For ollama, provider selection does not trigger managed proxy
          provider: provider === "openai" ? "openai" : "anthropic",
          model: "test-model",
        });
        expect(listProviders()).toContain(provider);
      },
    );

    test("all five managed providers register via managed fallback simultaneously", () => {
      enableManagedProxy();
      initializeProviders({
        apiKeys: {},
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      for (const p of MANAGED_PROVIDERS) {
        expect(registered).toContain(p);
      }
    });
  });

  describe("neither user keys nor managed context → providers not initialized", () => {
    test.each(MANAGED_PROVIDERS)(
      "%s is NOT registered when no user key and no managed context",
      (provider: string) => {
        disableManagedProxy();
        initializeProviders({
          apiKeys: {},
          provider: "anthropic",
          model: "test-model",
        });
        expect(listProviders()).not.toContain(provider);
      },
    );

    test("registry is empty when no keys and no managed context (non-ollama primary)", () => {
      disableManagedProxy();
      initializeProviders({
        apiKeys: {},
        provider: "anthropic",
        model: "test-model",
      });
      expect(listProviders()).toEqual([]);
    });
  });

  describe("mixed: some user keys + managed fallback fills gaps", () => {
    test("user key for anthropic, managed fallback fills remaining four", () => {
      enableManagedProxy();
      initializeProviders({
        apiKeys: userKeysFor("anthropic"),
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      expect(registered).toContain("anthropic");
      expect(registered).toContain("openai");
      expect(registered).toContain("gemini");
      expect(registered).toContain("fireworks");
      expect(registered).toContain("openrouter");
    });

    test("user key for openai, managed fallback fills remaining four", () => {
      enableManagedProxy();
      initializeProviders({
        apiKeys: userKeysFor("openai"),
        provider: "openai",
        model: "test-model",
      });
      const registered = listProviders();
      for (const p of MANAGED_PROVIDERS) {
        expect(registered).toContain(p);
      }
    });
  });
});

describe("managed proxy integration — ollama exclusion", () => {
  test("ollama is never registered via managed proxy fallback", () => {
    enableManagedProxy();
    initializeProviders({
      apiKeys: {},
      provider: "anthropic",
      model: "test-model",
    });
    expect(listProviders()).not.toContain("ollama");
  });

  test("ollama registers only when explicitly configured as provider", () => {
    enableManagedProxy();
    initializeProviders({
      apiKeys: {},
      provider: "ollama",
      model: "test-model",
    });
    expect(listProviders()).toContain("ollama");
  });

  test("ollama registers with explicit API key", () => {
    enableManagedProxy();
    initializeProviders({
      apiKeys: { ollama: "ollama-key" },
      provider: "anthropic",
      model: "test-model",
    });
    expect(listProviders()).toContain("ollama");
  });

  test("ollama metadata is marked as non-managed", () => {
    const meta = MANAGED_PROVIDER_META.ollama;
    expect(meta).toBeDefined();
    expect(meta.managed).toBe(false);
    expect(meta.proxyPath).toBeUndefined();
  });
});

describe("managed proxy integration — constants integrity", () => {
  test("all five managed providers have metadata with managed=true and a proxyPath", () => {
    for (const provider of MANAGED_PROVIDERS) {
      const meta = MANAGED_PROVIDER_META[provider];
      expect(meta).toBeDefined();
      expect(meta.managed).toBe(true);
      expect(meta.proxyPath).toBeTruthy();
      expect(meta.proxyPath).toMatch(/^\/v1\/runtime-proxy\//);
    }
  });

  test("managed proxy paths are unique across providers", () => {
    const paths = Object.values(MANAGED_PROVIDER_META)
      .filter((m) => m.managed && m.proxyPath)
      .map((m) => m.proxyPath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
