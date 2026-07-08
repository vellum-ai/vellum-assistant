/**
 * Tests for watcher usage telemetry.
 *
 * Strategy: stub the checkpoint store, lifecycle-event store, and
 * watcher store via `mock.module()` so we can drive the inventory
 * throttle and event naming without touching the DB.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const checkpoints = new Map<string, string>();
const recordedEvents: string[] = [];
let fakeEnabledWatchers: Array<{ providerId: string }> = [];
let recordImpl: (name: string) => void = (name) => {
  recordedEvents.push(name);
};

mock.module("../../persistence/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => checkpoints.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpoints.set(key, value);
  },
}));

mock.module("../../persistence/lifecycle-events-store.js", () => ({
  recordLifecycleEvent: (name: string) => {
    recordImpl(name);
    return null;
  },
}));

mock.module("../watcher-store.js", () => ({
  listWatchers: () => fakeEnabledWatchers,
}));

const {
  recordWatcherInventoryIfDue,
  recordWatcherLlmProcessed,
  WATCHER_INVENTORY_INTERVAL_MS,
} = await import("../telemetry.js");

const INVENTORY_KEY = "telemetry:watchers:inventory_last_recorded";
// Realistic epoch base: an absent checkpoint reads as 0, so `now` must be
// at least one interval past the epoch for the inventory to be due.
const BASE = 1_700_000_000_000;

beforeEach(() => {
  checkpoints.clear();
  recordedEvents.length = 0;
  fakeEnabledWatchers = [];
  recordImpl = (name) => {
    recordedEvents.push(name);
  };
});

describe("recordWatcherInventoryIfDue", () => {
  test("records one event per enabled watcher when due", () => {
    fakeEnabledWatchers = [
      { providerId: "gmail" },
      { providerId: "linear" },
      { providerId: "gmail" },
    ];

    recordWatcherInventoryIfDue(BASE);

    expect(recordedEvents).toEqual([
      "watcher_enabled:gmail",
      "watcher_enabled:linear",
      "watcher_enabled:gmail",
    ]);
    expect(checkpoints.get(INVENTORY_KEY)).toBe(String(BASE));
  });

  test("skips when the last inventory is within the interval", () => {
    fakeEnabledWatchers = [{ providerId: "gmail" }];
    checkpoints.set(INVENTORY_KEY, String(BASE));

    recordWatcherInventoryIfDue(BASE + WATCHER_INVENTORY_INTERVAL_MS - 1);

    expect(recordedEvents).toEqual([]);
    expect(checkpoints.get(INVENTORY_KEY)).toBe(String(BASE));
  });

  test("records again once the interval has elapsed", () => {
    fakeEnabledWatchers = [{ providerId: "github" }];
    checkpoints.set(INVENTORY_KEY, String(BASE));

    recordWatcherInventoryIfDue(BASE + WATCHER_INVENTORY_INTERVAL_MS);

    expect(recordedEvents).toEqual(["watcher_enabled:github"]);
  });

  test("advances the checkpoint even when no watchers are enabled", () => {
    recordWatcherInventoryIfDue(BASE + 1);

    expect(recordedEvents).toEqual([]);
    expect(checkpoints.get(INVENTORY_KEY)).toBe(String(BASE + 1));
  });

  test("swallows storage errors and leaves the checkpoint for retry", () => {
    fakeEnabledWatchers = [{ providerId: "gmail" }];
    recordImpl = () => {
      throw new Error("db unavailable");
    };

    expect(() => recordWatcherInventoryIfDue(BASE + 2)).not.toThrow();
    // Checkpoint must not advance on failure: the next tick retries
    // instead of skipping a day of inventory.
    expect(checkpoints.get(INVENTORY_KEY)).toBeUndefined();

    recordImpl = (name) => {
      recordedEvents.push(name);
    };
    recordWatcherInventoryIfDue(BASE + 3);

    expect(recordedEvents).toEqual(["watcher_enabled:gmail"]);
    expect(checkpoints.get(INVENTORY_KEY)).toBe(String(BASE + 3));
  });
});

describe("recordWatcherLlmProcessed", () => {
  test("embeds provider and conversation id in the event name", () => {
    recordWatcherLlmProcessed("linear", "conv-123");

    expect(recordedEvents).toEqual(["watcher_llm_processed:linear:conv-123"]);
  });

  test("swallows storage errors", () => {
    recordImpl = () => {
      throw new Error("db unavailable");
    };

    expect(() => recordWatcherLlmProcessed("gmail", "conv-456")).not.toThrow();
  });
});
