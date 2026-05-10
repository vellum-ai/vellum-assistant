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

// Capture logger output so coalescing tests can assert on it. Existing
// tests don't read the array, so capturing is invisible to them.
//
// Bun's `mock.module("../../src/util/logger.js", ...)` does not intercept
// transitive imports (see comment in stt-hints.test.ts and avatar-e2e.test.ts).
// Mocking `pino` at the package level works because getLogger uses pino
// child loggers under the hood — intercepting pino captures everything.
interface LogCall {
  level: "warn" | "info" | "error" | "debug";
  fields: Record<string, unknown>;
  message: string;
}
const logCalls: LogCall[] = [];

function makeLogFn(level: LogCall["level"]) {
  return (
    fieldsOrMsg: Record<string, unknown> | string,
    maybeMsg?: string,
  ) => {
    if (typeof fieldsOrMsg === "string") {
      logCalls.push({ level, fields: {}, message: fieldsOrMsg });
    } else {
      logCalls.push({
        level,
        fields: fieldsOrMsg,
        message: maybeMsg ?? "",
      });
    }
  };
}

const mockChildLogger = {
  debug: () => {},
  info: makeLogFn("info"),
  warn: makeLogFn("warn"),
  error: makeLogFn("error"),
  fatal: () => {},
  trace: () => {},
  silent: () => {},
  // pino loggers are themselves callable as a no-op shorthand; child() returns
  // another logger.
  child(): typeof mockChildLogger {
    return mockChildLogger;
  },
  bindings: () => ({}),
  level: "info",
};

const mockPinoLogger = Object.assign(() => mockChildLogger, {
  destination: () => ({}),
  multistream: () => ({}),
  stdTimeFunctions: { isoTime: () => "" },
  stdSerializers: {},
  symbols: {},
});

mock.module("pino", () => ({ default: mockPinoLogger }));
mock.module("pino-pretty", () => ({ default: () => ({}) }));

import {
  _clearGlobalCacheForTesting,
  _getFailureStateForTesting,
  _resetFailureCoalesceForTesting,
  _setFailureWarnIntervalForTesting,
  getAutoApproveThreshold,
} from "../../src/permissions/gateway-threshold-reader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetMocks(): void {
  ipcCallLog.length = 0;
  ipcHandler = () => undefined;
  logCalls.length = 0;
  _clearGlobalCacheForTesting();
  _resetFailureCoalesceForTesting();
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

// ── Failure coalescing ───────────────────────────────────────────────────────

describe("failure-coalescing log behavior", () => {
  test("first failure WARNs immediately and starts a streak", async () => {
    ipcHandler = () => {
      throw new Error("Connection refused");
    };

    expect(await getAutoApproveThreshold(undefined, "background")).toBe("none");

    const warns = logCalls.filter((c) => c.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0]?.fields).toMatchObject({
      op: "global_thresholds",
      consecutiveFailures: 1,
      event: "ipc_threshold_failure",
    });

    const state = _getFailureStateForTesting("global_thresholds");
    expect(state).toBeDefined();
    expect(state?.consecutiveFailures).toBe(1);
  });

  test("subsequent failures within the WARN window do not log but still increment state", async () => {
    // 1-hour window so the test never accidentally crosses it.
    _setFailureWarnIntervalForTesting(60 * 60 * 1000);
    ipcHandler = () => {
      throw new Error("ENOENT");
    };

    for (let i = 0; i < 100; i++) {
      _clearGlobalCacheForTesting(); // force re-fetch each call
      await getAutoApproveThreshold(undefined, "background");
    }

    const warns = logCalls.filter((c) => c.level === "warn");
    // At most one WARN — the very first call. All 99 follow-ups suppressed.
    expect(warns.length).toBe(1);

    const state = _getFailureStateForTesting("global_thresholds");
    expect(state?.consecutiveFailures).toBe(100);
  });

  test("a fresh WARN fires once the cadence window elapses", async () => {
    // 5ms window so the test runs fast.
    _setFailureWarnIntervalForTesting(5);
    ipcHandler = () => {
      throw new Error("ENOENT");
    };

    await getAutoApproveThreshold(undefined, "background");
    expect(logCalls.filter((c) => c.level === "warn").length).toBe(1);

    // Wait past the window then fail again.
    await new Promise((r) => setTimeout(r, 20));
    _clearGlobalCacheForTesting();
    await getAutoApproveThreshold(undefined, "background");

    const warns = logCalls.filter((c) => c.level === "warn");
    expect(warns.length).toBe(2);
    // Second WARN includes the streak metadata so dashboards can see how
    // many failures were swallowed in between.
    expect(warns[1]?.fields).toMatchObject({
      op: "global_thresholds",
      consecutiveFailures: 2,
      event: "ipc_threshold_failure",
    });
    expect(warns[1]?.fields.streakDurationMs).toBeDefined();
  });

  test("recovery emits an INFO with the swallowed-failure count and clears state", async () => {
    _setFailureWarnIntervalForTesting(60 * 60 * 1000);
    let working = false;
    ipcHandler = (method) => {
      if (working && method === "get_global_thresholds") {
        return { interactive: "medium", autonomous: "low" };
      }
      throw new Error("ENOENT");
    };

    // Three failures, then it recovers.
    for (let i = 0; i < 3; i++) {
      _clearGlobalCacheForTesting();
      await getAutoApproveThreshold(undefined, "background");
    }
    expect(_getFailureStateForTesting("global_thresholds")?.consecutiveFailures).toBe(
      3,
    );

    working = true;
    _clearGlobalCacheForTesting();
    expect(await getAutoApproveThreshold(undefined, "background")).toBe("low");

    const infos = logCalls.filter((c) => c.level === "info");
    expect(infos.length).toBe(1);
    expect(infos[0]?.fields).toMatchObject({
      op: "global_thresholds",
      swallowedFailures: 3,
      event: "ipc_threshold_recovered",
    });
    expect(infos[0]?.fields.streakDurationMs).toBeDefined();

    expect(_getFailureStateForTesting("global_thresholds")).toBeUndefined();
  });

  test("conversation and global ops have independent failure streaks", async () => {
    _setFailureWarnIntervalForTesting(60 * 60 * 1000);
    // conversation IPC fails (transport — returns undefined), global IPC works.
    ipcHandler = (method) => {
      if (method === "get_conversation_threshold") return undefined;
      if (method === "get_global_thresholds") {
        return { interactive: "medium", autonomous: "low" };
      }
      return undefined;
    };

    // First call: conversation transport fails, global succeeds.
    expect(await getAutoApproveThreshold("conv-1", "conversation")).toBe(
      "medium",
    );

    expect(
      _getFailureStateForTesting("conversation_threshold")?.consecutiveFailures,
    ).toBe(1);
    expect(_getFailureStateForTesting("global_thresholds")).toBeUndefined();

    const warns = logCalls.filter((c) => c.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0]?.fields.op).toBe("conversation_threshold");
  });

  test("a successful conversation override clears the conversation streak even when the gateway returns null (no override)", async () => {
    _setFailureWarnIntervalForTesting(60 * 60 * 1000);

    // First two calls: conversation IPC returns undefined (transport failure).
    let working = false;
    ipcHandler = (method) => {
      if (method === "get_conversation_threshold") {
        return working ? null : undefined;
      }
      if (method === "get_global_thresholds") {
        return { interactive: "low", autonomous: "none" };
      }
      return undefined;
    };

    // Force two transport failures.
    await getAutoApproveThreshold("conv-2", "conversation");
    await new Promise((r) => setTimeout(r, 6)); // bypass the 5s convo cache
    _clearGlobalCacheForTesting();
    // Convo cache is keyed on conversationId — change the id to bypass.
    await getAutoApproveThreshold("conv-3", "conversation");
    expect(
      _getFailureStateForTesting("conversation_threshold")?.consecutiveFailures,
    ).toBe(2);

    // Now the IPC starts working — even a null "no override" response is a
    // successful round-trip and must clear the streak.
    working = true;
    _clearGlobalCacheForTesting();
    await getAutoApproveThreshold("conv-4", "conversation");

    const infos = logCalls.filter((c) => c.level === "info");
    expect(infos.length).toBe(1);
    expect(infos[0]?.fields).toMatchObject({
      op: "conversation_threshold",
      swallowedFailures: 2,
      event: "ipc_threshold_recovered",
    });
    expect(_getFailureStateForTesting("conversation_threshold")).toBeUndefined();
  });
});
