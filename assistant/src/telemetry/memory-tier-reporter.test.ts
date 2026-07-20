import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { memoryTier } from "../config/memory-tier.js";
import type { AssistantConfig } from "../config/schema.js";
import type { ConsentState } from "../platform/consent-cache.js";
import type { WatchdogEventRecord } from "./watchdog-events-store.js";

// Mutable stubs flipped per test. bun's `mock.module` patches retroactively
// (live bindings), so the reporter's imports resolve to these regardless of
// import order (mirrors `outbox-test-harness.ts`). Kept off the outbox/DB path
// on purpose: mocking `recordWatchdogEvent` lets these assert emission without
// standing up the telemetry DB.
let consent: ConsentState = true;
let currentConfig: AssistantConfig = {} as AssistantConfig;
let recorded: WatchdogEventRecord[] = [];

mock.module("../platform/consent-cache.js", () => ({
  getRawShareAnalytics: () => consent,
}));
mock.module("../config/loader.js", () => ({
  getConfigReadOnly: () => currentConfig,
}));
mock.module("./watchdog-events-store.js", () => ({
  recordWatchdogEvent: (record: WatchdogEventRecord) => {
    recorded.push(record);
  },
}));

import {
  recordMemoryTierOnce,
  startMemoryTierReporter,
  stopMemoryTierReporter,
} from "./memory-tier-reporter.js";

function makeConfig(
  enabled: boolean,
  v2Enabled: boolean,
  v3Live = false,
): AssistantConfig {
  return {
    memory: {
      enabled,
      v2: { enabled: v2Enabled },
      v3: { live: v3Live },
    },
  } as AssistantConfig;
}

describe("memory-tier-reporter", () => {
  beforeEach(() => {
    consent = true;
    currentConfig = {} as AssistantConfig;
    recorded = [];
    // Clear any interval/boot-retry timer a prior test's start left behind.
    stopMemoryTierReporter();
  });

  afterEach(() => {
    stopMemoryTierReporter();
    delete process.env.VELLUM_DEV;
  });

  test("emits a memory_tier watchdog carrying the current tier", () => {
    const config = makeConfig(true, true); // memory on, v2 enabled → "v2"
    currentConfig = config;

    recordMemoryTierOnce();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      checkName: "memory_tier",
      detail: { tier: memoryTier(config) },
    });
    expect(recorded[0]?.detail?.tier).toBe("v2");
  });

  test("reflects a different tier for a different config (v3 live)", () => {
    currentConfig = makeConfig(true, true, true); // v3 live wins over v2
    recordMemoryTierOnce();

    expect(recorded[0]?.detail).toEqual({ tier: "v3" });
  });

  test("emits every invocation — no memo", () => {
    currentConfig = makeConfig(true, false); // "v1"
    recordMemoryTierOnce();
    recordMemoryTierOnce();
    recordMemoryTierOnce();

    expect(recorded).toHaveLength(3);
    for (const event of recorded) {
      expect(event).toEqual({
        checkName: "memory_tier",
        detail: { tier: "v1" },
      });
    }
  });

  test("unknown consent emits nothing", () => {
    consent = "unknown";
    currentConfig = makeConfig(true, true);

    recordMemoryTierOnce();

    expect(recorded).toHaveLength(0);
  });

  test("a confirmed opt-out still calls through (recordWatchdogEvent no-ops)", () => {
    // The reporter only skips the UNKNOWN state; the `false` opt-out is
    // honored one layer down in `recordWatchdogEvent`. Here that layer is the
    // stub, so the call is observed — the drop is the real store's concern.
    consent = false;
    currentConfig = makeConfig(true, true);

    recordMemoryTierOnce();

    expect(recorded).toHaveLength(1);
  });

  test("startMemoryTierReporter is a no-op under VELLUM_DEV=1", () => {
    process.env.VELLUM_DEV = "1";
    consent = true; // consent known → a non-dev start would emit immediately
    currentConfig = makeConfig(true, true);

    startMemoryTierReporter();

    // No boot emit and no interval scheduled.
    expect(recorded).toHaveLength(0);
  });
});
