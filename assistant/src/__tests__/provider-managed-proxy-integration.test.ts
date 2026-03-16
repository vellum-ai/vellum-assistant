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
  getSecureKeyAsync: async (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey;
    }
    return mockProviderKeys[key] ?? null;
  },
}));

import type { ProvidersConfig } from "../providers/registry.js";
import {
  getProvider,
  getProviderRoutingSource,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";

function makeProvidersConfig(provider: string, model: string): ProvidersConfig {
  return {
    services: {
      inference: { mode: "your-own", provider, model },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-2.5-flash-image",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM_BASE = "https://platform.example.com";
const MANAGED_API_KEY = "ast-managed-key-123";

const DIRECT_OR_MANAGED_PROVIDER_KEYS: string[] = [
  "openai",
  "anthropic",
  "gemini",
  "fireworks",
  "openrouter",
];
const MANAGED_FALLBACK_PROVIDERS: string[] = ["anthropic", "gemini"];

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
    test.each(DIRECT_OR_MANAGED_PROVIDER_KEYS)(
      "%s routes via user-key when user key is provided regardless of managed context",
      async (provider: string) => {
        enableManagedProxy();
        setUserKeysFor(provider);
        await initializeProviders(makeProvidersConfig(provider, "test-model"));
        expect(listProviders()).toContain(provider);
        expect(getProviderRoutingSource(provider)).toBe("user-key");
      },
    );

    test("all five configured providers route via user-key when user keys exist", async () => {
      enableManagedProxy();
      setUserKeysFor(...DIRECT_OR_MANAGED_PROVIDER_KEYS);
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      const registered = listProviders();
      for (const p of DIRECT_OR_MANAGED_PROVIDER_KEYS) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("user-key");
      }
    });

    test("user keys still route via user-key when managed context is disabled", async () => {
      disableManagedProxy();
      setUserKeysFor(...DIRECT_OR_MANAGED_PROVIDER_KEYS);
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      const registered = listProviders();
      for (const p of DIRECT_OR_MANAGED_PROVIDER_KEYS) {
        expect(registered).toContain(p);
        expect(getProviderRoutingSource(p)).toBe("user-key");
      }
    });
  });

  describe("user keys absent + managed context available → providers use managed proxy", () => {
    test.each(MANAGED_FALLBACK_PROVIDERS)(
      "%s routes via managed-proxy when no user key",
      async (provider: string) => {
        enableManagedProxy();
        mockProviderKeys = {};
        await initializeProviders(
          makeProvidersConfig("anthropic", "test-model"),
        );
        expect(listProviders()).toContain(provider);
        expect(getProviderRoutingSource(provider)).toBe("managed-proxy");
      },
    );

    test("managed bootstrap registers anthropic and gemini only", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      expect(listProviders()).toEqual(["anthropic", "gemini"]);
      expect(getProviderRoutingSource("anthropic")).toBe("managed-proxy");
      expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");
      for (const p of ["openai", "fireworks", "openrouter"]) {
        expect(getProviderRoutingSource(p)).toBeUndefined();
      }
    });

    test("managed anthropic uses anthropic proxy path", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(
        makeProvidersConfig("anthropic", "claude-opus-4-6"),
      );

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

    test("managed gemini uses vertex proxy path", async () => {
      enableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));

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
    test.each(DIRECT_OR_MANAGED_PROVIDER_KEYS)(
      "%s is NOT registered when no user key and no managed context",
      async (provider: string) => {
        disableManagedProxy();
        mockProviderKeys = {};
        await initializeProviders(
          makeProvidersConfig("anthropic", "test-model"),
        );
        expect(listProviders()).not.toContain(provider);
        expect(getProviderRoutingSource(provider)).toBeUndefined();
      },
    );

    test("registry is empty when no keys and no managed context (non-ollama primary)", async () => {
      disableManagedProxy();
      mockProviderKeys = {};
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      expect(listProviders()).toEqual([]);
    });
  });

  describe("mixed: some user keys + managed fallback fills gaps", () => {
    test("user key for anthropic routes direct and managed fallback only fills gemini", async () => {
      enableManagedProxy();
      setUserKeysFor("anthropic");
      await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
      const registered = listProviders();
      expect(registered).toContain("anthropic");
      expect(getProviderRoutingSource("anthropic")).toBe("user-key");
      expect(registered).toContain("gemini");
      expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");
      for (const p of ["openai", "fireworks", "openrouter"]) {
        expect(registered).not.toContain(p);
        expect(getProviderRoutingSource(p)).toBeUndefined();
      }
    });

    test("user key for openai routes direct while anthropic and gemini still bootstrap via managed proxy", async () => {
      enableManagedProxy();
      setUserKeysFor("openai");
      await initializeProviders(makeProvidersConfig("openai", "test-model"));
      const registered = listProviders();
      expect(registered).toContain("openai");
      expect(getProviderRoutingSource("openai")).toBe("user-key");
      expect(registered).toContain("anthropic");
      expect(getProviderRoutingSource("anthropic")).toBe("managed-proxy");
      expect(registered).toContain("gemini");
      expect(getProviderRoutingSource("gemini")).toBe("managed-proxy");
      for (const p of ["fireworks", "openrouter"]) {
        expect(registered).not.toContain(p);
        expect(getProviderRoutingSource(p)).toBeUndefined();
      }
    });
  });
});

describe("managed proxy integration — ollama exclusion", () => {
  test("ollama is never registered via managed proxy fallback", async () => {
    enableManagedProxy();
    mockProviderKeys = {};
    await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
    expect(listProviders()).not.toContain("ollama");
  });

  test("ollama registers only when explicitly configured as provider", async () => {
    enableManagedProxy();
    mockProviderKeys = {};
    await initializeProviders(makeProvidersConfig("ollama", "test-model"));
    expect(listProviders()).toContain("ollama");
  });

  test("ollama registers with explicit API key", async () => {
    enableManagedProxy();
    mockProviderKeys = { ollama: "ollama-key" };
    await initializeProviders(makeProvidersConfig("anthropic", "test-model"));
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
  test("anthropic, gemini, and vertex have metadata with managed=true and a proxyPath", () => {
    for (const provider of ["anthropic", "gemini", "vertex"]) {
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

  test("openai-compatible providers are not managed proxy capable", () => {
    for (const provider of ["openai", "fireworks", "openrouter"]) {
      expect(MANAGED_PROVIDER_META[provider].managed).toBe(false);
      expect(MANAGED_PROVIDER_META[provider].proxyPath).toBeUndefined();
    }
  });
});
