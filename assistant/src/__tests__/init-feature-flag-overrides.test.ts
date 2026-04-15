/**
 * Tests for initFeatureFlagOverrides() — the async IPC call that
 * pre-populates the feature flag cache before CLI program construction.
 *
 * Mocks `node:net` so the real gateway-client.ts code is exercised
 * without needing a live gateway socket.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Fake socket that simulates the gateway IPC protocol.
// ---------------------------------------------------------------------------

/** Feature flag values the fake gateway will return. */
let ipcResult: Record<string, boolean> = {};

/** Whether the fake socket should simulate a connection error. */
let simulateError = false;

class FakeSocket extends EventEmitter {
  unref() {
    /* no-op */
  }
  destroy() {
    /* no-op */
  }
  write(data: string) {
    // Parse the incoming IPC request and respond with the configured flags.
    try {
      const req = JSON.parse(data.trim());
      const response = JSON.stringify({
        id: req.id,
        result: ipcResult,
      });
      // Respond asynchronously (next tick), matching real socket behaviour.
      queueMicrotask(() => {
        this.emit("data", Buffer.from(response + "\n"));
      });
    } catch {
      // Malformed request — ignore
    }
  }
}

mock.module("node:net", () => {
  return {
    connect(_path: string) {
      const socket = new FakeSocket();
      // Simulate async connect / error on next tick
      queueMicrotask(() => {
        if (simulateError) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          socket.emit("error", err);
          socket.emit("close");
        } else {
          socket.emit("connect");
        }
      });
      return socket;
    },
  };
});

import {
  clearFeatureFlagOverridesCache,
  initFeatureFlagOverrides,
  isAssistantFeatureFlagEnabled,
} from "../config/assistant-feature-flags.js";

beforeEach(() => {
  clearFeatureFlagOverridesCache();
  ipcResult = {};
  simulateError = false;
});

afterEach(() => {
  clearFeatureFlagOverridesCache();
  ipcResult = {};
  simulateError = false;
});

describe("initFeatureFlagOverrides", () => {
  it("populates cache from gateway IPC response", async () => {
    ipcResult = { "foo-enabled": true, "bar-enabled": true };

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("bar-enabled", config)).toBe(true);
  });

  it("falls back gracefully when gateway socket is unavailable", async () => {
    simulateError = true;

    // Should not throw
    await initFeatureFlagOverrides();

    // Without gateway data or file, undeclared flags default to true
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("respects false values from gateway IPC", async () => {
    ipcResult = { "gated-feature": true, "disabled-feature": false };

    await initFeatureFlagOverrides();

    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("gated-feature", config)).toBe(true);
    expect(isAssistantFeatureFlagEnabled("disabled-feature", config)).toBe(
      false,
    );
  });

  it("does not cache empty gateway response", async () => {
    ipcResult = {};

    await initFeatureFlagOverrides();

    // Undeclared flags without overrides default to true (not false from
    // a cached empty map)
    const config = {} as any;
    expect(isAssistantFeatureFlagEnabled("foo-enabled", config)).toBe(true);
  });

  it("does not re-fetch when cache is already populated", async () => {
    ipcResult = { "first-call": true };

    await initFeatureFlagOverrides();

    // Change what IPC would return — if the guard is broken and init
    // re-fetches, "first-call" would flip to false.
    ipcResult = { "first-call": false, "second-call": true };

    await initFeatureFlagOverrides();

    const config = {} as any;
    // first-call must still be true (from the cached first fetch)
    expect(isAssistantFeatureFlagEnabled("first-call", config)).toBe(true);
    // second-call should not be in the cache since init was a no-op
    expect(isAssistantFeatureFlagEnabled("second-call", config)).toBe(true); // defaults to true (undeclared)
  });
});
