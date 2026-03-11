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
  getSecureKey: (key: string) => {
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

  test("returns disabled when platform URL is empty", () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = "sk-test-key";

    const ctx = resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.platformBaseUrl).toBe("");
  });

  test("returns disabled when assistant API key is missing", () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = null;

    const ctx = resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.assistantApiKey).toBe("");
  });

  test("returns disabled when both are missing", () => {
    const ctx = resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
  });

  test("returns enabled when both platform URL and API key are present", () => {
    mockPlatformBaseUrl = "https://platform.example.com/";
    mockAssistantApiKey = "sk-test-key";

    const ctx = resolveManagedProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.platformBaseUrl).toBe("https://platform.example.com");
    expect(ctx.assistantApiKey).toBe("sk-test-key");
  });

  test("strips trailing slashes from platform URL", () => {
    mockPlatformBaseUrl = "https://platform.example.com///";
    mockAssistantApiKey = "sk-test-key";

    const ctx = resolveManagedProxyContext();
    expect(ctx.platformBaseUrl).toBe("https://platform.example.com");
  });
});

describe("hasManagedProxyPrereqs", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
  });

  test("returns false when prerequisites are missing", () => {
    expect(hasManagedProxyPrereqs()).toBe(false);
  });

  test("returns true when prerequisites are satisfied", () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    expect(hasManagedProxyPrereqs()).toBe(true);
  });
});

describe("buildManagedBaseUrl", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
  });

  test("builds correct URL for managed providers", () => {
    expect(buildManagedBaseUrl("openai")).toBe(
      "https://platform.example.com/v1/runtime-proxy/openai",
    );
    expect(buildManagedBaseUrl("anthropic")).toBe(
      "https://platform.example.com/v1/runtime-proxy/vertex",
    );
    expect(buildManagedBaseUrl("gemini")).toBe(
      "https://platform.example.com/v1/runtime-proxy/vertex",
    );
    expect(buildManagedBaseUrl("fireworks")).toBe(
      "https://platform.example.com/v1/runtime-proxy/fireworks",
    );
    expect(buildManagedBaseUrl("openrouter")).toBe(
      "https://platform.example.com/v1/runtime-proxy/openrouter",
    );
  });

  test("returns undefined for non-managed provider (ollama)", () => {
    expect(buildManagedBaseUrl("ollama")).toBeUndefined();
  });

  test("returns undefined for unknown provider", () => {
    expect(buildManagedBaseUrl("unknown-provider")).toBeUndefined();
  });

  test("returns undefined when prerequisites are missing", () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    expect(buildManagedBaseUrl("openai")).toBeUndefined();
  });
});

describe("managedFallbackEnabledFor", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
  });

  test("returns true for managed providers with prerequisites", () => {
    expect(managedFallbackEnabledFor("openai")).toBe(true);
    expect(managedFallbackEnabledFor("anthropic")).toBe(true);
  });

  test("returns false for non-managed provider", () => {
    expect(managedFallbackEnabledFor("ollama")).toBe(false);
  });

  test("returns false for unknown provider", () => {
    expect(managedFallbackEnabledFor("unknown")).toBe(false);
  });

  test("returns false when prerequisites are missing", () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    expect(managedFallbackEnabledFor("openai")).toBe(false);
  });
});
