/**
 * Regression test for Gap D: ConfigWatcher.refreshConfigFromSources must
 * reset the cleanup-scheduler throttle when memory.cleanup retention
 * settings change. Without this, a user flipping their retention setting
 * in the UI would have to wait up to 6 hours (the default
 * enqueueIntervalMs) before the change takes effect, because
 * maybeEnqueueScheduledCleanupJobs (in jobs-worker) early-returns while
 * the throttle is still within its window.
 *
 * The shared throttle state lives in memory/cleanup-schedule-state.ts so
 * that config-watcher can reset it without pulling jobs-worker's large
 * transitive import graph into test modules. This test stubs the
 * schedule-state module so calls from config-watcher can be counted
 * directly.
 *
 * Two layers are exercised:
 *   1. Pure helper test for cleanupSettingsChanged().
 *   2. Integration test asserting ConfigWatcher.refreshConfigFromSources
 *      invokes resetCleanupScheduleThrottle at the right times.
 *
 * memory-jobs-worker-backoff.test.ts covers the jobs-worker throttle
 * semantics directly.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { MemoryCleanupConfig } from "../config/schemas/memory-lifecycle.js";
import { cleanupSettingsChanged } from "../daemon/config-watcher.js";

// ---------------------------------------------------------------------------
// 1. Pure helper test — cleanupSettingsChanged
// ---------------------------------------------------------------------------

describe("cleanupSettingsChanged", () => {
  const base: MemoryCleanupConfig = {
    enabled: true,
    enqueueIntervalMs: 6 * 60 * 60 * 1000,
    supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
    conversationRetentionDays: 0,
    llmRequestLogRetentionMs: 1 * 24 * 60 * 60 * 1000,
  };

  test("returns false when either side is undefined", () => {
    expect(cleanupSettingsChanged(undefined, base)).toBe(false);
    expect(cleanupSettingsChanged(base, undefined)).toBe(false);
    expect(cleanupSettingsChanged(undefined, undefined)).toBe(false);
  });

  test("returns false when all fields are equal", () => {
    expect(cleanupSettingsChanged(base, { ...base })).toBe(false);
  });

  test("returns true when llmRequestLogRetentionMs changes", () => {
    expect(
      cleanupSettingsChanged(base, {
        ...base,
        llmRequestLogRetentionMs: 7 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  test("returns true when conversationRetentionDays changes", () => {
    expect(
      cleanupSettingsChanged(base, {
        ...base,
        conversationRetentionDays: 30,
      }),
    ).toBe(true);
  });

  test("returns true when cleanup.enabled toggles", () => {
    expect(cleanupSettingsChanged(base, { ...base, enabled: false })).toBe(
      true,
    );
  });

  test("returns false when only non-tracked fields change", () => {
    // enqueueIntervalMs and supersededItemRetentionMs are intentionally
    // excluded — they are daemon tunables, not user-facing UI settings.
    expect(
      cleanupSettingsChanged(base, {
        ...base,
        enqueueIntervalMs: 1_000,
        supersededItemRetentionMs: 0,
      }),
    ).toBe(false);
  });

  test("returns true when llmRequestLogRetentionMs changes from number to null", () => {
    expect(
      cleanupSettingsChanged(base, {
        ...base,
        llmRequestLogRetentionMs: null,
      }),
    ).toBe(true);
  });

  test("returns true when llmRequestLogRetentionMs changes from null to number", () => {
    const nullBase = { ...base, llmRequestLogRetentionMs: null };
    expect(
      cleanupSettingsChanged(nullBase, {
        ...nullBase,
        llmRequestLogRetentionMs: 86_400_000,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Integration test — ConfigWatcher calls resetCleanupScheduleThrottle
// ---------------------------------------------------------------------------

// Track calls from config-watcher into the (mocked) cleanup-schedule-state.
let resetCleanupScheduleThrottleCalls = 0;

mock.module("../memory/cleanup-schedule-state.js", () => ({
  resetCleanupScheduleThrottle: () => {
    resetCleanupScheduleThrottleCalls++;
  },
  getLastScheduledCleanupEnqueueMs: () => 0,
  markScheduledCleanupEnqueued: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (v: string) => v,
}));

// Simulate a config-cache layer: `diskConfig` is the on-disk value,
// `cachedConfig` is what getConfig() returns until invalidateConfigCache()
// is called. This matches the production behavior where getConfig() returns
// a memoized value that only refreshes after explicit invalidation. Tests
// mutate `diskConfig` to simulate a user writing a new config.json.
interface TestConfig {
  memory: {
    enabled: boolean;
    cleanup: {
      enabled: boolean;
      enqueueIntervalMs: number;
      supersededItemRetentionMs: number;
      conversationRetentionDays: number;
      llmRequestLogRetentionMs: number | null;
    };
  };
}

let diskConfig: TestConfig = makeConfig();
let cachedConfig: TestConfig | null = null;

function makeConfig(
  overrides: Partial<TestConfig["memory"]["cleanup"]> = {},
): TestConfig {
  return {
    memory: {
      enabled: true,
      cleanup: {
        enabled: true,
        enqueueIntervalMs: 6 * 60 * 60 * 1000,
        supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
        conversationRetentionDays: 0,
        llmRequestLogRetentionMs: 1 * 24 * 60 * 60 * 1000,
        ...overrides,
      },
    },
  };
}

function primeConfigCache(): void {
  cachedConfig = diskConfig;
}

mock.module("../config/loader.js", () => ({
  getConfig: () => {
    if (!cachedConfig) {
      cachedConfig = diskConfig;
    }
    return cachedConfig;
  },
  invalidateConfigCache: () => {
    cachedConfig = null;
  },
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  clearFeatureFlagOverridesCache: () => {},
}));

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../signals/bash.js", () => ({
  handleBashSignal: () => {},
}));

mock.module("../signals/cancel.js", () => ({
  handleCancelSignal: () => {},
}));

mock.module("../signals/conversation-undo.js", () => ({
  handleConversationUndoSignal: () => {},
}));

mock.module("../signals/emit-event.js", () => ({
  handleEmitEventSignal: () => {},
}));

mock.module("../signals/mcp-reload.js", () => ({
  handleMcpReloadSignal: () => {},
}));

mock.module("../signals/user-message.js", () => ({
  handleUserMessageSignal: () => {},
}));

// Import ConfigWatcher AFTER mocks are declared.
const { ConfigWatcher } = await import("../daemon/config-watcher.js");

describe("ConfigWatcher.refreshConfigFromSources cleanup throttle reset", () => {
  beforeEach(() => {
    resetCleanupScheduleThrottleCalls = 0;
    diskConfig = makeConfig();
    cachedConfig = null;
  });

  test("resets throttle when llmRequestLogRetentionMs changes", async () => {
    const watcher = new ConfigWatcher();
    // Seed the initial fingerprint and prime the cache so refreshConfigFromSources
    // can compare the prev (cached) and next (fresh-from-disk) snapshots.
    watcher.initFingerprint(diskConfig as never);
    primeConfigCache();

    // Simulate user changing retention from 1d to 7d via the UI — this
    // writes to disk and is ONLY visible to getConfig() after a cache
    // invalidation.
    diskConfig = makeConfig({
      llmRequestLogRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(1);
  });

  test("does NOT reset throttle when config is identical (no fingerprint change)", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(diskConfig as never);
    primeConfigCache();

    // No change: diskConfig is the same value.
    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(false);
    expect(resetCleanupScheduleThrottleCalls).toBe(0);
  });

  test("does NOT reset throttle when an unrelated cleanup field changes", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(diskConfig as never);
    primeConfigCache();

    // enqueueIntervalMs is a daemon tunable, not a user-facing setting.
    // The fingerprint changes but the tracked cleanup retention fields
    // don't, so the throttle should NOT be reset.
    diskConfig = makeConfig({ enqueueIntervalMs: 30_000 });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(0);
  });

  test("resets throttle when conversationRetentionDays changes", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(diskConfig as never);
    primeConfigCache();

    diskConfig = makeConfig({ conversationRetentionDays: 30 });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(1);
  });

  test("resets throttle when llmRequestLogRetentionMs changes from number to null", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(diskConfig as never);
    primeConfigCache();

    diskConfig = makeConfig({ llmRequestLogRetentionMs: null });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(1);
  });

  test("end-to-end: retention change via watcher triggers repeated resets", async () => {
    // This is the user-facing regression guarantee: each time the user
    // changes retention via the UI, refreshConfigFromSources calls the
    // cleanup-schedule-state throttle reset so the next scheduler tick
    // re-evaluates without waiting out the 6-hour window.
    //
    // Because cleanup-schedule-state is mocked here, we verify the
    // CONTRACT (resetCleanupScheduleThrottle is called) rather than the
    // internal state. memory-jobs-worker-backoff tests cover the
    // jobs-worker throttle semantics independently.
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(diskConfig as never);
    primeConfigCache();

    expect(resetCleanupScheduleThrottleCalls).toBe(0);

    diskConfig = makeConfig({
      llmRequestLogRetentionMs: 3 * 24 * 60 * 60 * 1000,
    });
    await watcher.refreshConfigFromSources();
    expect(resetCleanupScheduleThrottleCalls).toBe(1);

    // Changing retention again should trigger another reset, confirming
    // the wiring holds up for repeated edits.
    diskConfig = makeConfig({
      llmRequestLogRetentionMs: 14 * 24 * 60 * 60 * 1000,
    });
    await watcher.refreshConfigFromSources();
    expect(resetCleanupScheduleThrottleCalls).toBe(2);
  });
});
