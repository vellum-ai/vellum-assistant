import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { memoryTier } from "../config/memory-tier.js";
import type { AssistantConfig } from "../config/schema.js";
import type { ConsentState } from "../platform/consent-cache.js";
import type { MemoryCorpusSize } from "./memory-corpus-size.js";
import type { WatchdogEventRecord } from "./watchdog-events-store.js";

// Mutable stubs flipped per test. bun's `mock.module` patches retroactively
// (live bindings), so the reporter's imports resolve to these regardless of
// import order (mirrors `outbox-test-harness.ts`). Kept off the outbox/DB path
// on purpose: mocking `recordWatchdogEvent` lets these assert emission without
// standing up the telemetry DB.
let consent: ConsentState = true;
let currentConfig: AssistantConfig = {} as AssistantConfig;
let recorded: WatchdogEventRecord[] = [];

// Stubbed so the assertions below stay exact-match: the real probe walks the
// live workspace, whose contents differ per machine. `measureMemoryCorpusSize`
// has its own tests against a temp tree.
const ZERO_CORPUS: MemoryCorpusSize = {
  concept_pages: 0,
  concept_bytes: 0,
  pkb_files: 0,
  pkb_bytes: 0,
  buffer_lines: 0,
};
let corpus: MemoryCorpusSize = ZERO_CORPUS;
let corpusError: Error | null = null;

mock.module("./memory-corpus-size.js", () => ({
  measureMemoryCorpusSize: () => {
    if (corpusError) {
      throw corpusError;
    }
    return corpus;
  },
}));
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
    corpus = ZERO_CORPUS;
    corpusError = null;
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
      detail: { tier: memoryTier(config), ...ZERO_CORPUS },
    });
    expect(recorded[0]?.detail?.tier).toBe("v2");
  });

  test("reflects a different tier for a different config (v3 live)", () => {
    currentConfig = makeConfig(true, true, true); // v3 live wins over v2
    recordMemoryTierOnce();

    expect(recorded[0]?.detail).toEqual({ tier: "v3", ...ZERO_CORPUS });
  });

  test("carries the measured corpus size alongside the tier", () => {
    currentConfig = makeConfig(true, true, true);
    corpus = {
      concept_pages: 42,
      concept_bytes: 133_700,
      pkb_files: 3,
      pkb_bytes: 900,
      buffer_lines: 7,
    };

    recordMemoryTierOnce();

    expect(recorded[0]?.detail).toEqual({ tier: "v3", ...corpus });
  });

  test("a failed corpus probe still emits the tier heartbeat", () => {
    // The fleet-mix dashboards read `detail.tier`; a sizing failure must
    // degrade the payload, never drop the event and gap the series.
    currentConfig = makeConfig(true, true, true);
    corpusError = new Error("workspace unreadable");

    recordMemoryTierOnce();

    expect(recorded).toHaveLength(1);
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
        detail: { tier: "v1", ...ZERO_CORPUS },
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

  test("a confirmed opt-out skips the corpus probe entirely", () => {
    // The event is dropped one layer down, so walking the workspace for it
    // would be pure cost on an assistant that asked us not to collect. The
    // throwing stub asserts the probe is never reached.
    consent = false;
    currentConfig = makeConfig(true, true);
    corpusError = new Error("probe must not run");

    recordMemoryTierOnce();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.detail).toEqual({ tier: "v2" });
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
