/**
 * Unit tests for the `host.config.*` skill IPC routes. Mocks the loader and
 * feature-flag resolver so the routes can be exercised without touching the
 * real config file or defaults registry.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock config loader + feature-flag resolver
// ---------------------------------------------------------------------------

let mockConfig: Record<string, unknown> = {};
let mockFlagValues: Record<string, boolean> = {};
const flagCalls: string[] = [];

mock.module("../../../config/loader.js", () => ({
  getConfig: () => mockConfig,
  // Reimplement so we don't depend on the real module's behavior.
  getNestedValue: (obj: Record<string, unknown>, path: string) => {
    const keys = path.split(".");
    let current: unknown = obj;
    for (const key of keys) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  },
}));

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    flagCalls.push(key);
    return mockFlagValues[key] ?? true;
  },
}));

const {
  hostConfigGetSectionRoute,
  hostConfigIsFeatureFlagEnabledRoute,
  configRoutes,
} = await import("../config.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockConfig = {};
  mockFlagValues = {};
  flagCalls.length = 0;
});

afterEach(() => {
  mockConfig = {};
  mockFlagValues = {};
  flagCalls.length = 0;
});

describe("host.config.getSection IPC route", () => {
  test("method is host.config.getSection", () => {
    expect(hostConfigGetSectionRoute.method).toBe("host.config.getSection");
  });

  test("returns a shallow section", async () => {
    mockConfig = { llm: { default: { provider: "anthropic" } } };

    const result = await hostConfigGetSectionRoute.handler({ path: "llm" });

    expect(result).toEqual({ default: { provider: "anthropic" } });
  });

  test("returns a nested section by dot-path", async () => {
    mockConfig = { llm: { default: { provider: "anthropic" } } };

    const result = await hostConfigGetSectionRoute.handler({
      path: "llm.default.provider",
    });

    expect(result).toBe("anthropic");
  });

  test("returns null for a missing path", async () => {
    mockConfig = {};

    const result = await hostConfigGetSectionRoute.handler({
      path: "does.not.exist",
    });

    expect(result).toBeNull();
  });

  test("rejects missing path", () => {
    expect(() => hostConfigGetSectionRoute.handler({})).toThrow();
  });

  test("rejects empty path", () => {
    expect(() => hostConfigGetSectionRoute.handler({ path: "" })).toThrow();
  });
});

describe("host.config.isFeatureFlagEnabled IPC route", () => {
  test("method is host.config.isFeatureFlagEnabled", () => {
    expect(hostConfigIsFeatureFlagEnabledRoute.method).toBe(
      "host.config.isFeatureFlagEnabled",
    );
  });

  test("delegates to the feature-flag resolver and returns true", async () => {
    mockFlagValues = { browser: true };

    const result = await hostConfigIsFeatureFlagEnabledRoute.handler({
      key: "browser",
    });

    expect(result).toBe(true);
    expect(flagCalls).toEqual(["browser"]);
  });

  test("returns false when the resolver says the flag is off", async () => {
    mockFlagValues = { "ces-tools": false };

    const result = await hostConfigIsFeatureFlagEnabledRoute.handler({
      key: "ces-tools",
    });

    expect(result).toBe(false);
  });

  test("rejects missing key", () => {
    expect(() => hostConfigIsFeatureFlagEnabledRoute.handler({})).toThrow();
  });

  test("rejects empty key", () => {
    expect(() =>
      hostConfigIsFeatureFlagEnabledRoute.handler({ key: "" }),
    ).toThrow();
  });
});

describe("configRoutes", () => {
  test("exports both config routes", () => {
    expect(configRoutes).toContain(hostConfigGetSectionRoute);
    expect(configRoutes).toContain(hostConfigIsFeatureFlagEnabledRoute);
  });
});
