/**
 * Tests for managed proxy Gemini embedding backend selection.
 *
 * Verifies that selectEmbeddingBackend correctly routes through the
 * managed proxy when the feature flag is enabled and managed proxy
 * prerequisites are satisfied.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Mocks — must be before importing the module under test
// ---------------------------------------------------------------------------

// Suppress logger output
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mutable state for managed proxy context
let mockPlatformBaseUrl = "";
let mockAssistantApiKey: string | null = null;
let mockProviderKeys: Record<string, string | null> = {};

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
  getOllamaBaseUrlEnv: () => "",
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey;
    }
    // Provider keys are looked up by plain name
    return mockProviderKeys[key] ?? null;
  },
}));

// Feature flag mock
const mockFeatureFlags: Record<string, boolean> = {};

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string, _config: unknown) => {
    return mockFeatureFlags[key] ?? false;
  },
}));

import type { AssistantConfig } from "../config/types.js";
import {
  clearEmbeddingBackendCache,
  selectEmbeddingBackend,
} from "../memory/embedding-backend.js";
import { GeminiEmbeddingBackend } from "../memory/embedding-gemini.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM_BASE = "https://platform.example.com";
const MANAGED_API_KEY = "ast-managed-key-123";

function enableManagedProxy() {
  mockPlatformBaseUrl = PLATFORM_BASE;
  mockAssistantApiKey = MANAGED_API_KEY;
}

function disableManagedProxy() {
  mockPlatformBaseUrl = "";
  mockAssistantApiKey = null;
}

function enableFlag() {
  mockFeatureFlags["managed-gemini-embeddings-enabled"] = true;
}

function disableFlag() {
  mockFeatureFlags["managed-gemini-embeddings-enabled"] = false;
}

function makeConfig(
  overrides: {
    provider?: string;
    geminiModel?: string;
    geminiDimensions?: number;
  } = {},
): AssistantConfig {
  return {
    memory: {
      embeddings: {
        provider: overrides.provider ?? "auto",
        localModel: "Xenova/bge-small-en-v1.5",
        openaiModel: "text-embedding-3-small",
        geminiModel: overrides.geminiModel ?? "gemini-embedding-2-preview",
        geminiDimensions: overrides.geminiDimensions,
        ollamaModel: "nomic-embed-text",
      },
      qdrant: {
        vectorSize: 384,
      },
    },
    services: {
      inference: { provider: "anthropic" },
    },
  } as unknown as AssistantConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  disableManagedProxy();
  disableFlag();
  mockProviderKeys = {};
  clearEmbeddingBackendCache();
});

afterEach(() => {
  clearEmbeddingBackendCache();
});

describe("managed proxy Gemini embedding selection", () => {
  test("selects managed proxy Gemini when flag enabled and proxy context available", async () => {
    enableManagedProxy();
    enableFlag();
    const config = makeConfig();

    const { backend, reason } = await selectEmbeddingBackend(config);

    expect(backend).not.toBeNull();
    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    expect(backend!.provider).toBe("gemini");
    expect(reason).toBeNull();
  });

  test("managed proxy backend uses default 3072 dimensions when geminiDimensions not set", async () => {
    enableManagedProxy();
    enableFlag();
    const config = makeConfig();

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    // Access the private dimensions field to verify default
    const dimensions = (backend as unknown as { dimensions: number })
      .dimensions;
    expect(dimensions).toBe(3072);
  });

  test("managed proxy backend uses explicit geminiDimensions when set", async () => {
    enableManagedProxy();
    enableFlag();
    const config = makeConfig({ geminiDimensions: 768 });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    const dimensions = (backend as unknown as { dimensions: number })
      .dimensions;
    expect(dimensions).toBe(768);
  });

  test("managed proxy backend uses managedBaseUrl (not direct Google API)", async () => {
    enableManagedProxy();
    enableFlag();
    const config = makeConfig();

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    const managedBaseUrl = (backend as unknown as { managedBaseUrl: string })
      .managedBaseUrl;
    expect(managedBaseUrl).toBe(`${PLATFORM_BASE}/v1/runtime-proxy/gemini`);
  });

  test("falls back to local when flag is disabled (no managed proxy)", async () => {
    enableManagedProxy();
    disableFlag();
    const config = makeConfig();

    const { backend } = await selectEmbeddingBackend(config);

    // With auto and no provider keys, falls through to local
    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe("local");
  });

  test("falls back to local when managed proxy context unavailable", async () => {
    disableManagedProxy();
    enableFlag();
    const config = makeConfig();

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe("local");
  });

  test("selects managed proxy when provider is explicitly gemini", async () => {
    enableManagedProxy();
    enableFlag();
    const config = makeConfig({ provider: "gemini" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    const managedBaseUrl = (backend as unknown as { managedBaseUrl: string })
      .managedBaseUrl;
    expect(managedBaseUrl).toContain("/v1/runtime-proxy/gemini");
  });

  test("does not use managed proxy when provider is explicitly local", async () => {
    enableManagedProxy();
    enableFlag();
    const config = makeConfig({ provider: "local" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe("local");
  });

  test("does not use managed proxy when provider is explicitly openai", async () => {
    enableManagedProxy();
    enableFlag();
    mockProviderKeys["openai"] = "user-openai-key";
    const config = makeConfig({ provider: "openai" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).not.toBeNull();
    expect(backend!.provider).toBe("openai");
  });

  test("direct Gemini key still works when flag is off", async () => {
    disableManagedProxy();
    disableFlag();
    mockProviderKeys["gemini"] = "user-gemini-key";
    const config = makeConfig({ provider: "gemini" });

    const { backend } = await selectEmbeddingBackend(config);

    expect(backend).toBeInstanceOf(GeminiEmbeddingBackend);
    expect(backend!.provider).toBe("gemini");
    // Should NOT use managed proxy
    const managedBaseUrl = (backend as unknown as { managedBaseUrl?: string })
      .managedBaseUrl;
    expect(managedBaseUrl).toBeUndefined();
  });
});
