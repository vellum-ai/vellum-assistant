import { beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

// Mock logger to suppress output
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mutable state for env and secure key stubs
let mockPlatformBaseUrl = "";
let mockAssistantApiKey: string | null = null;

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey;
    }
    return null;
  },
}));

import {
  buildManagedBaseUrl,
  hasManagedProxyPrereqs,
  managedFallbackEnabledFor,
  resolveManagedProxyContext,
} from "../providers/managed-proxy/context.js";

describe("resolveManagedProxyContext", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
  });

  test("returns disabled when platform URL is empty", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = "sk-test-key";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.platformBaseUrl).toBe("");
  });

  test("returns disabled when assistant API key is missing", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = null;

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.assistantApiKey).toBe("");
  });

  test("returns disabled when both are missing", async () => {
    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
  });

  test("returns enabled when both platform URL and API key are present", async () => {
    mockPlatformBaseUrl = "https://platform.example.com/";
    mockAssistantApiKey = "sk-test-key";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.platformBaseUrl).toBe("https://platform.example.com");
    expect(ctx.assistantApiKey).toBe("sk-test-key");
  });

  test("strips trailing slashes from platform URL", async () => {
    mockPlatformBaseUrl = "https://platform.example.com///";
    mockAssistantApiKey = "sk-test-key";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.platformBaseUrl).toBe("https://platform.example.com");
  });
});

describe("hasManagedProxyPrereqs", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
  });

  test("returns false when prerequisites are missing", async () => {
    expect(await hasManagedProxyPrereqs()).toBe(false);
  });

  test("returns true when prerequisites are satisfied", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    expect(await hasManagedProxyPrereqs()).toBe(true);
  });
});

describe("buildManagedBaseUrl", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
  });

  test("builds correct URL for managed providers", async () => {
    expect(await buildManagedBaseUrl("anthropic")).toBe(
      "https://platform.example.com/v1/runtime-proxy/anthropic",
    );
    expect(await buildManagedBaseUrl("gemini")).toBe(
      "https://platform.example.com/v1/runtime-proxy/gemini",
    );
  });

  test("returns undefined for non-managed providers", async () => {
    expect(await buildManagedBaseUrl("openai")).toBeUndefined();
    expect(await buildManagedBaseUrl("fireworks")).toBeUndefined();
    expect(await buildManagedBaseUrl("openrouter")).toBeUndefined();
    expect(await buildManagedBaseUrl("ollama")).toBeUndefined();
  });

  test("returns undefined for unknown provider", async () => {
    expect(await buildManagedBaseUrl("unknown-provider")).toBeUndefined();
  });

  test("returns undefined when prerequisites are missing", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    expect(await buildManagedBaseUrl("anthropic")).toBeUndefined();
    expect(await buildManagedBaseUrl("gemini")).toBeUndefined();
  });
});

describe("managedFallbackEnabledFor", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
  });

  test("returns true only for managed fallback providers with prerequisites", async () => {
    expect(await managedFallbackEnabledFor("anthropic")).toBe(true);
    expect(await managedFallbackEnabledFor("gemini")).toBe(true);
    expect(await managedFallbackEnabledFor("openai")).toBe(false);
  });

  test("returns false for non-managed provider", async () => {
    expect(await managedFallbackEnabledFor("ollama")).toBe(false);
  });

  test("returns false for unknown provider", async () => {
    expect(await managedFallbackEnabledFor("unknown")).toBe(false);
  });

  test("returns false when prerequisites are missing", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    expect(await managedFallbackEnabledFor("anthropic")).toBe(false);
    expect(await managedFallbackEnabledFor("gemini")).toBe(false);
  });
});
