import { describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Mock the underlying dependencies of managed-proxy/context.js rather than
// the context module itself. This avoids global mock bleed: other test files
// that import context.js will still get the real implementation with their
// own dependency mocks.
// ---------------------------------------------------------------------------
let mockPlatformBaseUrl = "";
let mockAssistantApiKey = "";
let mockProviderKeys: Record<string, string> = {};

const actualEnv = await import("../config/env.js");
mock.module("../config/env.js", () => ({
  ...actualEnv,
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));

const actualSecureKeys = await import("../security/secure-keys.js");
mock.module("../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKey: (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey || null;
    }
    return mockProviderKeys[key] ?? null;
  },
}));

import {
  getFailoverProvider,
  initializeProviders,
  listProviders,
  resolveProviderSelection,
} from "../providers/registry.js";
import { ProviderNotConfiguredError } from "../util/errors.js";

/**
 * Tests for fail-open provider selection: when the configured primary provider
 * is unavailable, the system should automatically fall back to the first
 * available provider in the provider order.
 */

/** Initialize registry with anthropic + openai for most tests. */
function setupTwoProviders() {
  mockProviderKeys = { anthropic: "test-key", openai: "test-key" };
  initializeProviders({
    provider: "anthropic",
    model: "test-model",
  });
}

/** Initialize registry with no providers (empty keys, non-registerable primary). */
function setupNoProviders() {
  mockProviderKeys = {};
  initializeProviders({
    provider: "gemini",
    model: "test-model",
  });
}

describe("resolveProviderSelection", () => {
  test("configured primary available → selected as primary", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("anthropic", ["openai"]);
    expect(result.selectedPrimary).toBe("anthropic");
    expect(result.usedFallbackPrimary).toBe(false);
    expect(result.availableProviders).toEqual(["anthropic", "openai"]);
  });

  test("configured primary unavailable + alternate available → alternate selected", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("gemini", ["anthropic", "openai"]);
    expect(result.selectedPrimary).toBe("anthropic");
    expect(result.usedFallbackPrimary).toBe(true);
    expect(result.availableProviders).toEqual(["anthropic", "openai"]);
  });

  test("configured primary unavailable + first alternate also unavailable → second alternate selected", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("gemini", ["fireworks", "openai"]);
    expect(result.selectedPrimary).toBe("openai");
    expect(result.usedFallbackPrimary).toBe(true);
    expect(result.availableProviders).toEqual(["openai"]);
  });

  test("deduplicates entries in providerOrder", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("anthropic", [
      "anthropic",
      "openai",
      "openai",
    ]);
    expect(result.availableProviders).toEqual(["anthropic", "openai"]);
  });

  test("unknown entries in providerOrder are filtered out", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("anthropic", [
      "nonexistent",
      "openai",
    ]);
    expect(result.availableProviders).toEqual(["anthropic", "openai"]);
  });

  test("no available providers → null selectedPrimary", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("gemini", ["fireworks", "ollama"]);
    expect(result.selectedPrimary).toBeNull();
    expect(result.usedFallbackPrimary).toBe(false);
    expect(result.availableProviders).toEqual([]);
  });

  test("empty providerOrder with available primary → primary only", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("anthropic", []);
    expect(result.selectedPrimary).toBe("anthropic");
    expect(result.usedFallbackPrimary).toBe(false);
    expect(result.availableProviders).toEqual(["anthropic"]);
  });

  test("empty providerOrder with unavailable primary → null", () => {
    setupTwoProviders();
    const result = resolveProviderSelection("gemini", []);
    expect(result.selectedPrimary).toBeNull();
    expect(result.availableProviders).toEqual([]);
  });
});

describe("getFailoverProvider (fail-open)", () => {
  test("returns provider when primary is available", () => {
    setupTwoProviders();
    const provider = getFailoverProvider("anthropic", ["openai"]);
    expect(provider).toBeDefined();
  });

  test("returns provider when primary is unavailable but alternate exists", () => {
    setupTwoProviders();
    const provider = getFailoverProvider("gemini", ["anthropic", "openai"]);
    expect(provider).toBeDefined();
  });

  test("throws ProviderNotConfiguredError when no providers are available", () => {
    setupNoProviders();
    expect(() => getFailoverProvider("gemini", ["fireworks"])).toThrow(
      ProviderNotConfiguredError,
    );
    try {
      getFailoverProvider("gemini", ["fireworks"]);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotConfiguredError);
      const typed = err as ProviderNotConfiguredError;
      expect(typed.requestedProvider).toBe("gemini");
      expect(typed.registeredProviders).toEqual([]);
      expect(typed.message).toMatch(/No providers available/);
    }
  });

  test("single available provider returns it directly (no failover wrapper)", () => {
    setupTwoProviders();
    const provider = getFailoverProvider("gemini", ["anthropic"]);
    // Should be a RetryProvider wrapping AnthropicProvider, not a FailoverProvider
    expect(provider.name).not.toBe("failover");
  });
});

// -------------------------------------------------------------------------
// Managed proxy fallback
// -------------------------------------------------------------------------

describe("managed proxy fallback", () => {
  function enableManagedProxy() {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "ast-key-123";
  }

  function disableManagedProxy() {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = "";
  }

  test("openai registered via managed fallback when no user key but proxy context is valid", () => {
    enableManagedProxy();
    try {
      mockProviderKeys = { anthropic: "test-key" };
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      const registered = listProviders();
      expect(registered).toContain("openai");
      expect(registered).toContain("fireworks");
      expect(registered).toContain("openrouter");
    } finally {
      disableManagedProxy();
    }
  });

  test("user key takes precedence over managed fallback", () => {
    enableManagedProxy();
    try {
      mockProviderKeys = { anthropic: "test-key", openai: "user-openai-key" };
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      // openai should be registered (via user key, not managed)
      const registered = listProviders();
      expect(registered).toContain("openai");
      // fireworks/openrouter should also be registered via managed fallback
      expect(registered).toContain("fireworks");
      expect(registered).toContain("openrouter");
    } finally {
      disableManagedProxy();
    }
  });

  test("managed fallback not activated when proxy context is disabled", () => {
    disableManagedProxy();
    mockProviderKeys = { anthropic: "test-key" };
    initializeProviders({
      provider: "anthropic",
      model: "test-model",
    });
    const registered = listProviders();
    expect(registered).not.toContain("openai");
    expect(registered).not.toContain("fireworks");
    expect(registered).not.toContain("openrouter");
  });

  test("managed providers participate in failover selection", () => {
    enableManagedProxy();
    try {
      mockProviderKeys = { anthropic: "test-key" };
      initializeProviders({
        provider: "anthropic",
        model: "test-model",
      });
      const selection = resolveProviderSelection("anthropic", [
        "openai",
        "fireworks",
      ]);
      expect(selection.availableProviders).toEqual([
        "anthropic",
        "openai",
        "fireworks",
      ]);
      expect(selection.selectedPrimary).toBe("anthropic");
      expect(selection.usedFallbackPrimary).toBe(false);
    } finally {
      disableManagedProxy();
    }
  });

  test("managed provider selected as primary when configured primary unavailable", () => {
    enableManagedProxy();
    try {
      // No anthropic key, no gemini key — only managed providers available
      mockProviderKeys = {};
      initializeProviders({
        provider: "openai",
        model: "test-model",
      });
      const selection = resolveProviderSelection("openai", ["fireworks"]);
      expect(selection.selectedPrimary).toBe("openai");
      expect(selection.usedFallbackPrimary).toBe(false);
    } finally {
      disableManagedProxy();
    }
  });
});
