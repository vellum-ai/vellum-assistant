import { afterEach, describe, expect, mock, test } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────────

mock.module("../../src/config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

mock.module("../../src/config/loader.js", () => ({
  getConfig: () => ({}),
}));

// Track ipcCall invocations for assertion
const ipcCallLog: string[] = [];

// Handler receives (method, params) and returns the IPC response value.
// Return `undefined` to simulate a transport failure.
// Return `null` for get_conversation_threshold to indicate "no override".
type IpcHandler = (method: string, params?: Record<string, unknown>) => unknown;
let ipcHandler: IpcHandler = () => undefined;

mock.module("../../src/ipc/gateway-client.js", () => ({
  ipcCall: async (method: string, params?: Record<string, unknown>) => {
    // Normalise to a readable key for assertions
    const key =
      method === "get_conversation_threshold" && params?.conversationId
        ? `/v1/permissions/thresholds/conversations/${params.conversationId}`
        : "/v1/permissions/thresholds";
    ipcCallLog.push(key);
    return ipcHandler(method, params);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetMocks(): void {
  ipcCallLog.length = 0;
  ipcHandler = () => undefined;
  _clearGlobalCacheForTesting();
}

afterEach(resetMocks);

// Convenience: set up a handler that returns the given global thresholds and,
// optionally, a per-conversation override threshold string.
function withGlobals(
  globals: { interactive: string; autonomous: string },
  conversationOverride?: { conversationId: string; threshold: string },
): void {
  ipcHandler = (method, params) => {
    if (method === "get_global_thresholds") return globals;
    if (method === "get_conversation_threshold") {
      const id = params?.conversationId;
      if (conversationOverride && id === conversationOverride.conversationId) {
        return { threshold: conversationOverride.threshold };
      }
      return null; // no override
    }
    return undefined;
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getAutoApproveThreshold", () => {
  test("returns global defaults when gateway returns them", async () => {
    withGlobals({ interactive: "medium", autonomous: "low" });

    // conversation maps to interactive
    expect(await getAutoApproveThreshold(undefined, "conversation")).toBe(
      "medium",
    );

    _clearGlobalCacheForTesting();

    // background maps to autonomous
    expect(await getAutoApproveThreshold(undefined, "background")).toBe("low");

    _clearGlobalCacheForTesting();

    // headless reads configured value (defaults to "none")
    expect(await getAutoApproveThreshold(undefined, "headless")).toBe("none");
  });

  test("headless threshold is configurable via gateway", async () => {
    withGlobals({ interactive: "medium", autonomous: "low", headless: "low" });

    expect(await getAutoApproveThreshold(undefined, "headless")).toBe("low");
  });

  test("returns conversation override when it exists", async () => {
    withGlobals(
      { interactive: "low", autonomous: "none" },
      { conversationId: "conv-xyz", threshold: "medium" },
    );

    const result = await getAutoApproveThreshold("conv-xyz", "conversation");
    expect(result).toBe("medium");
    // Should have called the conversation endpoint, not the global one
    expect(ipcCallLog).toEqual([
      "/v1/permissions/thresholds/conversations/conv-xyz",
    ]);
  });

  test("falls back to global when conversation override returns null (no override)", async () => {
    withGlobals({ interactive: "low", autonomous: "none" });
    // ipcHandler returns null for get_conversation_threshold (no row)

    const result = await getAutoApproveThreshold("conv-123", "conversation");
    expect(result).toBe("low");
    // Called conversation endpoint first, then global
    expect(ipcCallLog).toEqual([
      "/v1/permissions/thresholds/conversations/conv-123",
      "/v1/permissions/thresholds",
    ]);
  });

  test("falls back to global when conversation ipc returns undefined (transport failure)", async () => {
    ipcHandler = (method) => {
      if (method === "get_conversation_threshold") return undefined; // transport failure
      if (method === "get_global_thresholds")
        return { interactive: "low", autonomous: "none" };
      return undefined;
    };

    const result = await getAutoApproveThreshold("conv-123", "conversation");
    expect(result).toBe("low");
  });

  test("falls back to 'none' (Strict) for all contexts on global gateway failure", async () => {
    // When the gateway IPC is unreachable, the reader defaults to "none" for
    // all contexts — defense-in-depth ensures no tools are silently
    // auto-approved when the gateway is down.
    ipcHandler = () => {
      throw new Error("Connection refused");
    };

    expect(await getAutoApproveThreshold(undefined, "conversation")).toBe(
      "none",
    );

    _clearGlobalCacheForTesting();

    expect(await getAutoApproveThreshold(undefined, "background")).toBe("none");

    _clearGlobalCacheForTesting();

    expect(await getAutoApproveThreshold(undefined, "headless")).toBe("none");
  });

  test("caching: second call within 30s does not re-fetch global", async () => {
    let fetchCount = 0;
    ipcHandler = (method) => {
      if (method === "get_global_thresholds") {
        fetchCount++;
        return { interactive: "medium", autonomous: "low" };
      }
      return null;
    };

    // First call — should fetch
    const first = await getAutoApproveThreshold(undefined, "conversation");
    expect(first).toBe("medium");
    expect(fetchCount).toBe(1);

    // Second call — should use cache
    const second = await getAutoApproveThreshold(undefined, "background");
    expect(second).toBe("low");
    expect(fetchCount).toBe(1); // Still 1, cache hit

    // Third call — headless also uses cache
    const third = await getAutoApproveThreshold(undefined, "headless");
    expect(third).toBe("none");
    expect(fetchCount).toBe(1); // Still 1

    // After clearing cache, should re-fetch
    _clearGlobalCacheForTesting();
    const fourth = await getAutoApproveThreshold(undefined, "conversation");
    expect(fourth).toBe("medium");
    expect(fetchCount).toBe(2); // Incremented
  });

  test("defaults executionContext to conversation when omitted", async () => {
    withGlobals({ interactive: "medium", autonomous: "low" });

    // executionContext omitted — should default to "conversation" → interactive
    const result = await getAutoApproveThreshold(undefined, undefined);
    expect(result).toBe("medium");
  });

  test("skips conversation override when no conversationId", async () => {
    withGlobals({ interactive: "low", autonomous: "none" });

    const result = await getAutoApproveThreshold(undefined, "conversation");
    expect(result).toBe("low");
    // Should only call global endpoint, not conversation
    expect(ipcCallLog).toEqual(["/v1/permissions/thresholds"]);
  });

  test("skips conversation override for non-conversation contexts", async () => {
    withGlobals({ interactive: "low", autonomous: "medium" });

    // Even with a conversationId, background context should not check conversation override
    const result = await getAutoApproveThreshold("conv-123", "background");
    expect(result).toBe("medium");
    expect(ipcCallLog).toEqual(["/v1/permissions/thresholds"]);
  });
});
