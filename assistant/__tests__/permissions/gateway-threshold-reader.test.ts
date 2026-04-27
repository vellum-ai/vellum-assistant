import { afterEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockFeatureFlagEnabled = true;

mock.module("../../src/config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (_key: string, _config: unknown) =>
    mockFeatureFlagEnabled,
}));

mock.module("../../src/config/loader.js", () => ({
  getConfig: () => ({}),
}));

// Track gatewayGet calls for assertion
const gatewayGetCalls: string[] = [];
let gatewayGetHandler: (path: string) => unknown = () => ({});

mock.module("../../src/runtime/gateway-internal-client.js", () => ({
  GatewayRequestError: class GatewayRequestError extends Error {
    statusCode: number;
    gatewayError: string | undefined;
    constructor(message: string, statusCode: number, gatewayError?: string) {
      super(message);
      this.name = "GatewayRequestError";
      this.statusCode = statusCode;
      this.gatewayError = gatewayError;
    }
  },
  gatewayGet: async <T>(path: string): Promise<T> => {
    gatewayGetCalls.push(path);
    return gatewayGetHandler(path) as T;
  },
}));

// Suppress logger output in tests
mock.module("../../src/util/logger.js", () => ({
  getLogger: () => ({
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import {
  _clearGlobalCacheForTesting,
  getAutoApproveThreshold,
} from "../../src/permissions/gateway-threshold-reader.js";
// Import GatewayRequestError from the mock so we can throw instances of it
const { GatewayRequestError } =
  await import("../../src/runtime/gateway-internal-client.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetMocks(): void {
  mockFeatureFlagEnabled = true;
  gatewayGetCalls.length = 0;
  gatewayGetHandler = () => ({});
  _clearGlobalCacheForTesting();
}

afterEach(resetMocks);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getAutoApproveThreshold", () => {
  test("returns undefined when feature flag is off", async () => {
    mockFeatureFlagEnabled = false;
    const result = await getAutoApproveThreshold("conv-123", "conversation");
    expect(result).toBeUndefined();
    // Should not make any gateway calls
    expect(gatewayGetCalls).toHaveLength(0);
  });

  test("returns global defaults when gateway returns them", async () => {
    gatewayGetHandler = (path: string) => {
      if (path === "/v1/permissions/thresholds") {
        return {
          interactive: "medium",
          autonomous: "low",
        };
      }
      return {};
    };

    // conversation maps to interactive
    expect(await getAutoApproveThreshold(undefined, "conversation")).toBe(
      "medium",
    );

    _clearGlobalCacheForTesting();

    // background maps to autonomous
    expect(await getAutoApproveThreshold(undefined, "background")).toBe("low");

    _clearGlobalCacheForTesting();

    // headless also maps to autonomous
    expect(await getAutoApproveThreshold(undefined, "headless")).toBe("low");
  });

  test("returns conversation override when it exists", async () => {
    gatewayGetHandler = (path: string) => {
      if (path === "/v1/permissions/thresholds/conversations/conv-xyz") {
        return { threshold: "medium" };
      }
      if (path === "/v1/permissions/thresholds") {
        return {
          interactive: "low",
          autonomous: "none",
        };
      }
      return {};
    };

    const result = await getAutoApproveThreshold("conv-xyz", "conversation");
    expect(result).toBe("medium");
    // Should have called the conversation endpoint, not the global one
    expect(gatewayGetCalls).toEqual([
      "/v1/permissions/thresholds/conversations/conv-xyz",
    ]);
  });

  test("falls back to global when conversation override returns 404", async () => {
    gatewayGetHandler = (path: string) => {
      if (path.startsWith("/v1/permissions/thresholds/conversations/")) {
        throw new GatewayRequestError("Not found", 404, "Not found");
      }
      if (path === "/v1/permissions/thresholds") {
        return {
          interactive: "low",
          autonomous: "none",
        };
      }
      return {};
    };

    const result = await getAutoApproveThreshold("conv-123", "conversation");
    expect(result).toBe("low");
    // Should have called both endpoints
    expect(gatewayGetCalls).toEqual([
      "/v1/permissions/thresholds/conversations/conv-123",
      "/v1/permissions/thresholds",
    ]);
  });

  test("falls back to hardcoded defaults on gateway error", async () => {
    gatewayGetHandler = () => {
      throw new Error("Connection refused");
    };

    // conversation → "low"
    expect(await getAutoApproveThreshold(undefined, "conversation")).toBe(
      "low",
    );

    _clearGlobalCacheForTesting();

    // background → "none" (maps to autonomous, which defaults to "none")
    expect(await getAutoApproveThreshold(undefined, "background")).toBe(
      "none",
    );

    _clearGlobalCacheForTesting();

    // headless → "none"
    expect(await getAutoApproveThreshold(undefined, "headless")).toBe("none");
  });

  test("falls back to hardcoded defaults on non-404 conversation error", async () => {
    gatewayGetHandler = (path: string) => {
      if (path.startsWith("/v1/permissions/thresholds/conversations/")) {
        throw new GatewayRequestError("Internal error", 500, "Server error");
      }
      // Should not reach global endpoint
      return {
        interactive: "medium",
        autonomous: "medium",
      };
    };

    const result = await getAutoApproveThreshold("conv-123", "conversation");
    // Should fall back to hardcoded default for conversation, not global endpoint
    expect(result).toBe("low");
    // Should have only called the conversation endpoint
    expect(gatewayGetCalls).toEqual([
      "/v1/permissions/thresholds/conversations/conv-123",
    ]);
  });

  test("caching: second call within 30s does not re-fetch global", async () => {
    let fetchCount = 0;
    gatewayGetHandler = (path: string) => {
      if (path === "/v1/permissions/thresholds") {
        fetchCount++;
        return {
          interactive: "medium",
          autonomous: "low",
        };
      }
      return {};
    };

    // First call — should fetch
    const first = await getAutoApproveThreshold(undefined, "conversation");
    expect(first).toBe("medium");
    expect(fetchCount).toBe(1);

    // Second call — should use cache
    const second = await getAutoApproveThreshold(undefined, "background");
    expect(second).toBe("low");
    expect(fetchCount).toBe(1); // Still 1, cache hit

    // Third call — still cached
    const third = await getAutoApproveThreshold(undefined, "headless");
    expect(third).toBe("low");
    expect(fetchCount).toBe(1); // Still 1

    // After clearing cache, should re-fetch
    _clearGlobalCacheForTesting();
    const fourth = await getAutoApproveThreshold(undefined, "conversation");
    expect(fourth).toBe("medium");
    expect(fetchCount).toBe(2); // Incremented
  });

  test("defaults executionContext to conversation when omitted", async () => {
    gatewayGetHandler = (path: string) => {
      if (path === "/v1/permissions/thresholds") {
        return {
          interactive: "medium",
          autonomous: "low",
        };
      }
      return {};
    };

    // executionContext omitted — should default to "conversation" → interactive
    const result = await getAutoApproveThreshold(undefined, undefined);
    expect(result).toBe("medium");
  });

  test("skips conversation override when no conversationId", async () => {
    gatewayGetHandler = (path: string) => {
      if (path === "/v1/permissions/thresholds") {
        return {
          interactive: "low",
          autonomous: "none",
        };
      }
      return {};
    };

    const result = await getAutoApproveThreshold(undefined, "conversation");
    expect(result).toBe("low");
    // Should only call global endpoint, not conversation
    expect(gatewayGetCalls).toEqual(["/v1/permissions/thresholds"]);
  });

  test("skips conversation override for non-conversation contexts", async () => {
    gatewayGetHandler = (path: string) => {
      if (path === "/v1/permissions/thresholds") {
        return {
          interactive: "low",
          autonomous: "medium",
        };
      }
      return {};
    };

    // Even with a conversationId, background context should not check conversation override
    const result = await getAutoApproveThreshold("conv-123", "background");
    expect(result).toBe("medium");
    expect(gatewayGetCalls).toEqual(["/v1/permissions/thresholds"]);
  });
});
