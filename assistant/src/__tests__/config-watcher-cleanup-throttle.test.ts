/**
 * Regression test for Gap D: ConfigWatcher.refreshConfigFromSources must
 * reset the cleanup-scheduler throttle when memory.cleanup retention
 * settings change. Each cleanup job now runs on a cadence equal to its own
 * retention window, so without this reset a user flipping their retention
 * setting in the UI could wait out that entire window before the change
 * takes effect, because maybeEnqueueScheduledCleanupJobs (in jobs-worker)
 * skips a job while its throttle is still within its window.
 *
 * The shared throttle state lives in persistence/cleanup-schedule-state.ts so
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

import { getConfig } from "../config/loader.js";
import type { MemoryCleanupConfig } from "../config/schemas/memory-lifecycle.js";
import { cleanupSettingsChanged } from "../daemon/config-watcher.js";
import { setConfig } from "./helpers/set-config.js";

// ---------------------------------------------------------------------------
// 1. Pure helper test — cleanupSettingsChanged
// ---------------------------------------------------------------------------

describe("cleanupSettingsChanged", () => {
  const base: MemoryCleanupConfig = {
    enabled: true,
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
    // supersededItemRetentionMs is intentionally excluded — it is a daemon
    // tunable, not a user-facing UI setting.
    expect(
      cleanupSettingsChanged(base, {
        ...base,
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

mock.module("../persistence/cleanup-schedule-state.js", () => ({
  resetCleanupScheduleThrottle: () => {
    resetCleanupScheduleThrottleCalls++;
  },
  getLastScheduledCleanupEnqueueMs: () => 0,
  markScheduledCleanupEnqueued: () => {},
}));

// Seed `memory.cleanup` in the real workspace config.json. Each call replaces
// the whole `memory` key, so tests simulate a user writing a new config.json
// by re-seeding with different cleanup values; the real loader cache picks the
// change up on the next getConfig() after invalidation (or via the file
// signature check).
function seedCleanup(
  overrides: Partial<{
    enabled: boolean;
    supersededItemRetentionMs: number;
    conversationRetentionDays: number;
    llmRequestLogRetentionMs: number | null;
  }> = {},
): void {
  setConfig("memory", {
    cleanup: {
      enabled: true,
      supersededItemRetentionMs: 30 * 24 * 60 * 60 * 1000,
      conversationRetentionDays: 0,
      llmRequestLogRetentionMs: 1 * 24 * 60 * 60 * 1000,
      ...overrides,
    },
  });
}

mock.module("../config/assistant-feature-flags.js", () => ({
  clearFeatureFlagOverridesCache: () => {},
}));

mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
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

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

mock.module("../signals/user-message.js", () => ({
  handleUserMessageSignal: () => {},
}));

// Import ConfigWatcher AFTER mocks are declared.
const { ConfigWatcher } = await import("../daemon/config-watcher.js");

describe("ConfigWatcher.refreshConfigFromSources cleanup throttle reset", () => {
  beforeEach(() => {
    resetCleanupScheduleThrottleCalls = 0;
    seedCleanup();
  });

  test("resets throttle when llmRequestLogRetentionMs changes", async () => {
    const watcher = new ConfigWatcher();
    // Seed the initial fingerprint (this also primes the loader cache) so
    // refreshConfigFromSources can compare the prev and next snapshots.
    watcher.initFingerprint(getConfig());

    // Simulate the user changing retention from 1d to 7d via the UI — this
    // writes config.json for real.
    seedCleanup({
      llmRequestLogRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(1);
  });

  test("resets throttle when the loader cache has already observed the disk change", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(getConfig());

    seedCleanup({
      llmRequestLogRetentionMs: 7 * 24 * 60 * 60 * 1000,
    });
    // The loader's file-signature check re-reads the changed file on this
    // access, so the cache already holds the new config before the refresh.
    getConfig();

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(1);
  });

  test("does NOT reset throttle when config is identical (no fingerprint change)", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(getConfig());

    // No change: config.json keeps the same value.
    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(false);
    expect(resetCleanupScheduleThrottleCalls).toBe(0);
  });

  test("does NOT reset throttle when an unrelated cleanup field changes", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(getConfig());

    // supersededItemRetentionMs is a daemon tunable, not a user-facing
    // setting. The fingerprint changes but the tracked cleanup retention
    // fields don't, so the throttle should NOT be reset.
    seedCleanup({ supersededItemRetentionMs: 60_000 });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(0);
  });

  test("resets throttle when conversationRetentionDays changes", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(getConfig());

    seedCleanup({ conversationRetentionDays: 30 });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(1);
  });

  test("resets throttle when llmRequestLogRetentionMs changes from number to null", async () => {
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(getConfig());

    seedCleanup({ llmRequestLogRetentionMs: null });

    const changed = await watcher.refreshConfigFromSources();
    expect(changed).toBe(true);
    expect(resetCleanupScheduleThrottleCalls).toBe(1);
  });

  test("end-to-end: retention change via watcher triggers repeated resets", async () => {
    // This is the user-facing regression guarantee: each time the user
    // changes retention via the UI, refreshConfigFromSources calls the
    // cleanup-schedule-state throttle reset so the next scheduler tick
    // re-evaluates without waiting out the retention-derived window.
    //
    // Because cleanup-schedule-state is mocked here, we verify the
    // CONTRACT (resetCleanupScheduleThrottle is called) rather than the
    // internal state. memory-jobs-worker-backoff tests cover the
    // jobs-worker throttle semantics independently.
    const watcher = new ConfigWatcher();
    watcher.initFingerprint(getConfig());

    expect(resetCleanupScheduleThrottleCalls).toBe(0);

    seedCleanup({
      llmRequestLogRetentionMs: 3 * 24 * 60 * 60 * 1000,
    });
    await watcher.refreshConfigFromSources();
    expect(resetCleanupScheduleThrottleCalls).toBe(1);

    // Changing retention again should trigger another reset, confirming
    // the wiring holds up for repeated edits.
    seedCleanup({
      llmRequestLogRetentionMs: 14 * 24 * 60 * 60 * 1000,
    });
    await watcher.refreshConfigFromSources();
    expect(resetCleanupScheduleThrottleCalls).toBe(2);
  });
});
