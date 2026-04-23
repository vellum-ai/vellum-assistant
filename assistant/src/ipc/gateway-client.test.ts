/**
 * Tests for the assistant's gateway IPC wrapper layer.
 *
 * Transport-level behavior (NDJSON framing, reconnection, timeout) is
 * covered by the @vellumai/gateway-client package tests. These tests
 * verify the assistant-specific wrapper: singleton lifecycle, feature
 * flag parsing, and socket path resolution.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  mockGatewayIpc,
  resetMockGatewayIpc,
} from "../__tests__/mock-gateway-ipc.js";
import {
  ipcCall,
  ipcCallPersistent,
  ipcGetFeatureFlags,
  resetPersistentClient,
} from "./gateway-client.js";

afterEach(() => {
  resetPersistentClient();
  resetMockGatewayIpc();
});

// ---------------------------------------------------------------------------
// ipcCall wrapper
// ---------------------------------------------------------------------------

describe("ipcCall", () => {
  test("delegates to package ipcCall and returns result", async () => {
    mockGatewayIpc(null, {
      results: { test_method: { key: "value" } },
    });

    const result = await ipcCall("test_method");
    expect(result).toEqual({ key: "value" });
  });

  test("returns undefined when mock simulates error", async () => {
    mockGatewayIpc(null, { error: true });

    const result = await ipcCall("test_method");
    expect(result).toBeUndefined();
  });

  test("returns undefined for unconfigured methods", async () => {
    const result = await ipcCall("unconfigured_method");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ipcCallPersistent singleton
// ---------------------------------------------------------------------------

describe("ipcCallPersistent", () => {
  test("returns result from persistent client", async () => {
    mockGatewayIpc(null, {
      results: { persistent_test: "persistent-result" },
    });

    const result = await ipcCallPersistent("persistent_test");
    expect(result).toBe("persistent-result");
  });

  test("throws when mock simulates error", async () => {
    mockGatewayIpc(null, { error: true });

    await expect(ipcCallPersistent("any_method")).rejects.toThrow(
      /Mock IPC socket error/,
    );
  });

  test("resetPersistentClient does not throw when no client exists", () => {
    // Should be a no-op when called before any ipcCallPersistent.
    expect(() => resetPersistentClient()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ipcGetFeatureFlags
// ---------------------------------------------------------------------------

describe("ipcGetFeatureFlags", () => {
  test("parses boolean flag values from IPC response", async () => {
    mockGatewayIpc({ "flag-a": true, "flag-b": false });

    const flags = await ipcGetFeatureFlags();
    expect(flags).toEqual({ "flag-a": true, "flag-b": false });
  });

  test("filters non-boolean values from response", async () => {
    mockGatewayIpc(null, {
      results: {
        get_feature_flags: {
          valid: true,
          number: 42,
          string: "yes",
          nested: { deep: true },
        },
      },
    });

    const flags = await ipcGetFeatureFlags();
    expect(flags).toEqual({ valid: true });
  });

  test("returns empty record when IPC returns undefined", async () => {
    // No mock configured — ipcCall returns undefined
    const flags = await ipcGetFeatureFlags();
    expect(flags).toEqual({});
  });

  test("returns empty record when IPC returns array", async () => {
    mockGatewayIpc(null, {
      results: { get_feature_flags: [true, false] },
    });

    const flags = await ipcGetFeatureFlags();
    expect(flags).toEqual({});
  });

  test("returns empty record on error", async () => {
    mockGatewayIpc(null, { error: true });

    const flags = await ipcGetFeatureFlags();
    expect(flags).toEqual({});
  });
});
