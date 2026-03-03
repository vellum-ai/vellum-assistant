import { afterEach, describe, expect, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import {
  clearAll,
  clearMode,
  getEffectiveMode,
  hasActiveOverride,
  setThreadMode,
  setTimedMode,
} from "../runtime/session-approval-overrides.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-approval-overrides", () => {
  afterEach(() => {
    clearAll();
  });

  // -----------------------------------------------------------------------
  // setThreadMode / getEffectiveMode
  // -----------------------------------------------------------------------
  describe("thread mode", () => {
    test("setThreadMode stores a thread override", () => {
      setThreadMode("conv-1");
      const mode = getEffectiveMode("conv-1");
      expect(mode).not.toBeNull();
      expect(mode!.kind).toBe("thread");
    });

    test("thread mode persists across multiple reads", () => {
      setThreadMode("conv-1");
      expect(getEffectiveMode("conv-1")).not.toBeNull();
      expect(getEffectiveMode("conv-1")).not.toBeNull();
    });

    test("thread mode is scoped to a specific conversationId", () => {
      setThreadMode("conv-1");
      expect(getEffectiveMode("conv-1")).not.toBeNull();
      expect(getEffectiveMode("conv-2")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // setTimedMode / getEffectiveMode
  // -----------------------------------------------------------------------
  describe("timed mode", () => {
    test("setTimedMode stores a timed override with default 10-minute TTL", () => {
      const before = Date.now();
      setTimedMode("conv-1");
      const after = Date.now();

      const mode = getEffectiveMode("conv-1");
      expect(mode).not.toBeNull();
      expect(mode!.kind).toBe("timed");

      const timed = mode!;
      if (timed.kind === "timed") {
        const expectedMin = before + 10 * 60 * 1000;
        const expectedMax = after + 10 * 60 * 1000;
        expect(timed.expiresAt).toBeGreaterThanOrEqual(expectedMin);
        expect(timed.expiresAt).toBeLessThanOrEqual(expectedMax);
      }
    });

    test("setTimedMode accepts a custom duration", () => {
      const before = Date.now();
      setTimedMode("conv-1", 5000);
      const after = Date.now();

      const mode = getEffectiveMode("conv-1");
      expect(mode).not.toBeNull();
      const timed = mode!;
      if (timed.kind === "timed") {
        expect(timed.expiresAt).toBeGreaterThanOrEqual(before + 5000);
        expect(timed.expiresAt).toBeLessThanOrEqual(after + 5000);
      }
    });

    test("timed mode expires after TTL elapses", async () => {
      setTimedMode("conv-1", 1); // 1ms TTL
      // Small delay to ensure expiry
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(getEffectiveMode("conv-1")).toBeNull();
    });

    test("expired timed mode is lazily cleaned up on read", async () => {
      setTimedMode("conv-1", 1);
      await new Promise((resolve) => setTimeout(resolve, 5));

      // First read triggers cleanup and returns null
      expect(getEffectiveMode("conv-1")).toBeNull();
      // Subsequent read also returns null (entry was removed)
      expect(getEffectiveMode("conv-1")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Mode replacement
  // -----------------------------------------------------------------------
  describe("mode replacement", () => {
    test("setTimedMode replaces an existing thread mode", () => {
      setThreadMode("conv-1");
      setTimedMode("conv-1", 60_000);

      const mode = getEffectiveMode("conv-1");
      expect(mode).not.toBeNull();
      expect(mode!.kind).toBe("timed");
    });

    test("setThreadMode replaces an existing timed mode", () => {
      setTimedMode("conv-1", 60_000);
      setThreadMode("conv-1");

      const mode = getEffectiveMode("conv-1");
      expect(mode).not.toBeNull();
      expect(mode!.kind).toBe("thread");
    });
  });

  // -----------------------------------------------------------------------
  // clearMode
  // -----------------------------------------------------------------------
  describe("clearMode", () => {
    test("clearMode removes a thread override", () => {
      setThreadMode("conv-1");
      clearMode("conv-1");
      expect(getEffectiveMode("conv-1")).toBeNull();
    });

    test("clearMode removes a timed override", () => {
      setTimedMode("conv-1", 60_000);
      clearMode("conv-1");
      expect(getEffectiveMode("conv-1")).toBeNull();
    });

    test("clearMode is a no-op for unknown conversationId", () => {
      // Should not throw
      clearMode("nonexistent");
      expect(getEffectiveMode("nonexistent")).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // hasActiveOverride
  // -----------------------------------------------------------------------
  describe("hasActiveOverride", () => {
    test("returns false when no override is set", () => {
      expect(hasActiveOverride("conv-1")).toBe(false);
    });

    test("returns true for active thread override", () => {
      setThreadMode("conv-1");
      expect(hasActiveOverride("conv-1")).toBe(true);
    });

    test("returns true for active timed override", () => {
      setTimedMode("conv-1", 60_000);
      expect(hasActiveOverride("conv-1")).toBe(true);
    });

    test("returns false after timed override expires", async () => {
      setTimedMode("conv-1", 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(hasActiveOverride("conv-1")).toBe(false);
    });

    test("returns false after clearMode", () => {
      setThreadMode("conv-1");
      clearMode("conv-1");
      expect(hasActiveOverride("conv-1")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // clearAll
  // -----------------------------------------------------------------------
  describe("clearAll", () => {
    test("clearAll removes all overrides", () => {
      setThreadMode("conv-1");
      setTimedMode("conv-2", 60_000);
      setThreadMode("conv-3");

      clearAll();

      expect(getEffectiveMode("conv-1")).toBeNull();
      expect(getEffectiveMode("conv-2")).toBeNull();
      expect(getEffectiveMode("conv-3")).toBeNull();
    });

    test("clearAll is safe to call on empty store", () => {
      // Should not throw
      clearAll();
      expect(hasActiveOverride("anything")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getEffectiveMode with no override
  // -----------------------------------------------------------------------
  test("getEffectiveMode returns null for unknown conversationId", () => {
    expect(getEffectiveMode("nonexistent")).toBeNull();
  });
});
