/**
 * Tests for the gateway-backed threshold reader, focused on
 * refreshAutoApproveThreshold(): the cache-bypassing re-read performed
 * before a permission prompt is surfaced. The reader's caches (5s
 * conversation TTL with negative caching, 30s global TTL) are never
 * invalidated by threshold writes, so without the refresh a user who just
 * switched to Full access could still be prompted from a stale snapshot.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence logger output during tests.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Controllable IPC mock ────────────────────────────────────────────────────

type IpcHandler = (params?: Record<string, unknown>) => unknown;

const ipcHandlers = new Map<string, IpcHandler>();
const ipcCallLog: Array<{ method: string; params?: Record<string, unknown> }> =
  [];

mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCallLog.push({ method, params });
    const handler = ipcHandlers.get(method);
    return handler ? handler(params) : undefined;
  },
  ipcCallPersistent: async () => undefined,
  resetPersistentClient: () => {},
}));

import {
  _clearGlobalCacheForTesting,
  _resetFailureCoalesceForTesting,
  getAutoApproveThreshold,
  refreshAutoApproveThreshold,
} from "./gateway-threshold-reader.js";

function countCalls(method: string): number {
  return ipcCallLog.filter((c) => c.method === method).length;
}

describe("refreshAutoApproveThreshold", () => {
  beforeEach(() => {
    _clearGlobalCacheForTesting();
    _resetFailureCoalesceForTesting();
    ipcHandlers.clear();
    ipcCallLog.length = 0;
  });

  test("bypasses a stale conversation cache and returns the fresh override", async () => {
    // Seed the cache with "low" via the normal read path.
    ipcHandlers.set("get_conversation_threshold", () => ({
      threshold: "low",
    }));
    expect(await getAutoApproveThreshold("conv-1", "conversation")).toBe("low");

    // The user switches the conversation to Full access — the gateway now
    // returns "high", but the reader's 5s cache still holds "low".
    ipcHandlers.set("get_conversation_threshold", () => ({
      threshold: "high",
    }));
    expect(await getAutoApproveThreshold("conv-1", "conversation")).toBe("low");

    // The refresh bypasses the cache and sees the new value.
    expect(await refreshAutoApproveThreshold("conv-1", "conversation")).toBe(
      "high",
    );
  });

  test("primes the conversation cache so subsequent reads skip IPC", async () => {
    ipcHandlers.set("get_conversation_threshold", () => ({
      threshold: "high",
    }));

    expect(await refreshAutoApproveThreshold("conv-2", "conversation")).toBe(
      "high",
    );
    const callsAfterRefresh = countCalls("get_conversation_threshold");

    expect(await getAutoApproveThreshold("conv-2", "conversation")).toBe(
      "high",
    );
    // Cache hit — no additional IPC round-trip.
    expect(countCalls("get_conversation_threshold")).toBe(callsAfterRefresh);
  });

  test("returns null when the conversation override read fails", async () => {
    // No handler registered → ipcCall returns undefined (transport failure).
    expect(
      await refreshAutoApproveThreshold("conv-3", "conversation"),
    ).toBeNull();
    // Must not fall through to the global read: without the override we
    // cannot know whether the conversation is stricter than the global.
    expect(countCalls("get_global_thresholds")).toBe(0);
  });

  test("falls through to a fresh global read when no override exists", async () => {
    ipcHandlers.set("get_conversation_threshold", () => null);
    ipcHandlers.set("get_global_thresholds", () => ({
      interactive: "high",
      autonomous: "low",
      headless: "none",
    }));

    expect(await refreshAutoApproveThreshold("conv-4", "conversation")).toBe(
      "high",
    );
  });

  test("bypasses a stale global cache", async () => {
    ipcHandlers.set("get_global_thresholds", () => ({
      interactive: "medium",
      autonomous: "low",
      headless: "none",
    }));
    expect(await getAutoApproveThreshold(undefined, "conversation")).toBe(
      "medium",
    );

    // The user switches the global interactive threshold to Full access —
    // the reader's 30s global cache still holds "medium".
    ipcHandlers.set("get_global_thresholds", () => ({
      interactive: "high",
      autonomous: "low",
      headless: "none",
    }));
    expect(await getAutoApproveThreshold(undefined, "conversation")).toBe(
      "medium",
    );

    expect(await refreshAutoApproveThreshold(undefined, "conversation")).toBe(
      "high",
    );

    // The refresh primed the global cache with the fresh values.
    expect(await getAutoApproveThreshold(undefined, "conversation")).toBe(
      "high",
    );
  });

  test("resolves the context-appropriate global field", async () => {
    ipcHandlers.set("get_global_thresholds", () => ({
      interactive: "high",
      autonomous: "medium",
      headless: "none",
    }));

    expect(await refreshAutoApproveThreshold("conv-5", "background")).toBe(
      "medium",
    );
    expect(await refreshAutoApproveThreshold("conv-5", "headless")).toBe(
      "none",
    );
    // Background/headless contexts never consult the per-conversation
    // override, mirroring getAutoApproveThreshold.
    expect(countCalls("get_conversation_threshold")).toBe(0);
  });

  test("returns null when the global read fails", async () => {
    expect(
      await refreshAutoApproveThreshold(undefined, "conversation"),
    ).toBeNull();
  });

  test("returns null for an invalid global value", async () => {
    ipcHandlers.set("get_global_thresholds", () => ({
      interactive: "bogus",
      autonomous: "low",
      headless: "none",
    }));
    expect(
      await refreshAutoApproveThreshold(undefined, "conversation"),
    ).toBeNull();
  });
});
