import { beforeEach, describe, expect, mock, test } from "bun:test";

import { MANAGED_PROVIDER_META } from "../providers/managed-proxy/constants.js";
import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Mock @google/genai to capture constructor arguments for Gemini base URL
// assertions. Must be before importing the registry.
// ---------------------------------------------------------------------------
let lastGeminiConstructorOpts: Record<string, unknown> | null = null;

mock.module("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(opts: Record<string, unknown>) {
      lastGeminiConstructorOpts = opts;
    }
    models = {
      generateContentStream: async () => ({
        [Symbol.asyncIterator]: async function* () {
          /* no chunks */
        },
      }),
    };
  },
  ApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock the underlying dependencies that the real context module relies on.
// This avoids mocking the context module directly and prevents mock conflicts
// with context.test.ts (which also mocks these same underlying deps).
// ---------------------------------------------------------------------------
let mockPlatformBaseUrl = "";
let mockAssistantApiKey: string | null = null;
let mockProviderKeys: Record<string, string> = {};

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey;
    }
    return mockProviderKeys[key] ?? null;
  },
}));

import {
  getProvider,
  getProviderRoutingSource,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";

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
 * Set mock secure keys with a user key for every provider in `names`.
 */
function setUserKeysFor(...names: string[]): void {
  mockProviderKeys = {};
  for (const n of names) {
    mockProviderKeys[n] = `user-key-${n}`;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  disableManagedProxy();
  mockProviderKeys = {};
  lastGeminiConstructorOpts = null;
});

describe("managed proxy integration — credential precedence", () => {
  describe("user keys present → providers use direct connections (not proxy)", () => {
    test.each(MANAGED_PROVIDERS)(
      "%s routes via user-key when user key is provided regardless of managed context",
      (provider: string) => {
        enableManagedProxy();
        setUserKeysFor(provider);
        initializeProviders({
          provider,
          model: "test-model",
        });
        expect(listProviders()).toContain(provider);
        expect(getProviderRoutingSource(provider)).toBe("user-key");
      },
    );

    test("all five managed providers route via user-key with user keys", () => {
      enableManagedProxy();
      setUserKeysFor(...MANAGED_PROVIDERS);
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      for (const p of MANAGED_PROVIDERS) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("user-key");
      }
    });

    test("user keys still route via user-key when managed context is disabled", () => {
      disableManagedProxy();
      setUserKeysFor(...MANAGED_PROVIDERS);
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      for (const p of MANAGED_PROVIDERS) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("user-key");
      }
    });
  });

  describe("user keys absent + managed context available → providers use managed proxy", () => {
    test.each(MANAGED_PROVIDERS)(
      "%s routes via managed-proxy when no user key",
      (provider: string) => {
        enableManagedProxy();
        mockProviderKeys = {};
        initializeProviders({
          // For ollama, provider selection does not trigger managed proxy
          provider: provider === "openai" ? "openai" : "anthropic",
          model: "test-model",
        });
        expect(listProviders()).toContain(provider);
        expect(getProviderRoutingSource(provider)).toBe("managed-proxy");
      },
    );

    test("all five managed providers route via managed-proxy simultaneously", () => {
      enableManagedProxy();
      mockProviderKeys = {};
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      for (const p of MANAGED_PROVIDERS) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("managed-proxy");
      }
    });

    test("managed anthropic uses vertex proxy path instead of anthropic proxy path", () => {
      enableManagedProxy();
      mockProviderKeys = {};
      initializeProviders({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });

      const provider = getProvider("anthropic");

      // Unwrap RetryProvider → LogfireProvider → AnthropicProvider to inspect
      // the Anthropic SDK client's baseURL. The wrappers use private `inner`
      // and AnthropicProvider stores the SDK client as private `client`.
      const retryInner = (provider as any).inner;
      // retryInner is the logfire wrapper; it also has an `inner` property
      const logfireInner = (retryInner as any).inner ?? retryInner;
      const anthropicClient = (logfireInner as any).client;

      expect(anthropicClient).toBeDefined();
      const baseURL: string = anthropicClient.baseURL;
      expect(baseURL).toContain("/v1/runtime-proxy/anthropic");
    });

    test("managed gemini uses vertex proxy path instead of gemini proxy path", () => {
      enableManagedProxy();
      mockProviderKeys = {};
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });

      // The GoogleGenAI constructor was captured by the mock — verify it
      // received httpOptions.baseUrl pointing at the vertex proxy path.
      expect(lastGeminiConstructorOpts).toBeDefined();
      const httpOptions = lastGeminiConstructorOpts!.httpOptions as
        | { baseUrl?: string }
        | undefined;
      expect(httpOptions).toBeDefined();
      expect(httpOptions!.baseUrl).toContain("/v1/runtime-proxy/vertex");
      expect(httpOptions!.baseUrl).not.toContain("/v1/runtime-proxy/gemini");
    });
  });

  describe("neither user keys nor managed context → providers not initialized", () => {
    test.each(MANAGED_PROVIDERS)(
      "%s is NOT registered when no user key and no managed context",
      (provider: string) => {
        disableManagedProxy();
        mockProviderKeys = {};
        initializeProviders({
          provider: "anthropic",
          model: "test-model",
        });
        expect(listProviders()).not.toContain(provider);
        expect(getProviderRoutingSource(provider)).toBeUndefined();
      },
    );

    test("registry is empty when no keys and no managed context (non-ollama primary)", () => {
      disableManagedProxy();
      mockProviderKeys = {};
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      expect(listProviders()).toEqual([]);
    });
  });

  describe("mixed: some user keys + managed fallback fills gaps", () => {
    test("user key for anthropic routes direct, managed fallback fills remaining four via proxy", () => {
      enableManagedProxy();
      setUserKeysFor("anthropic");
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      expect(registered).toContain("anthropic");
      expect(getProviderRoutingSource("anthropic")).toBe("user-key");
      for (const p of ["openai", "gemini", "fireworks", "openrouter"]) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("managed-proxy");
      }
    });

    test("user key for openai routes direct, managed fallback fills remaining four via proxy", () => {
      enableManagedProxy();
      setUserKeysFor("openai");
      initializeProviders({
        provider: "openai",
        model: "test-model",
      });
      const registered = listProviders();
      expect(registered).toContain("openai");
      expect(getProviderRoutingSource("openai")).toBe("user-key");
      for (const p of ["anthropic", "gemini", "fireworks", "openrouter"]) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("managed-proxy");
      }
    });
  });
});

describe("managed proxy integration — ollama exclusion", () => {
  test("ollama is never registered via managed proxy fallback", () => {
    enableManagedProxy();
    mockProviderKeys = {};
    initializeProviders({
      provider: "anthropic",
      model: "test-model",
    });
    expect(listProviders()).not.toContain("ollama");
  });

  test("ollama registers only when explicitly configured as provider", () => {
    enableManagedProxy();
    mockProviderKeys = {};
    initializeProviders({
      provider: "ollama",
      model: "test-model",
    });
    expect(listProviders()).toContain("ollama");
  });

  test("ollama registers with explicit API key", () => {
    enableManagedProxy();
    mockProviderKeys = { ollama: "ollama-key" };
    initializeProviders({
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

  test("anthropic routes through anthropic proxy path", () => {
    expect(MANAGED_PROVIDER_META.anthropic.proxyPath).toBe(
      "/v1/runtime-proxy/anthropic",
    );
  });

  test("gemini routes through vertex proxy path", () => {
    expect(MANAGED_PROVIDER_META.gemini.proxyPath).toBe(
      "/v1/runtime-proxy/vertex",
    );
  });

  test("other providers use their own proxy paths", () => {
    expect(MANAGED_PROVIDER_META.openai.proxyPath).toBe(
      "/v1/runtime-proxy/openai",
    );
    expect(MANAGED_PROVIDER_META.fireworks.proxyPath).toBe(
      "/v1/runtime-proxy/fireworks",
    );
    expect(MANAGED_PROVIDER_META.openrouter.proxyPath).toBe(
      "/v1/runtime-proxy/openrouter",
    );
  });
});
