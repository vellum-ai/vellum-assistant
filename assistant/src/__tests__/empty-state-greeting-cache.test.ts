/**
 * Unit tests for the empty-state greeting cache
 * (runtime/routes/empty-state-greeting-cache.ts).
 *
 * Validates TTL round-tripping, expiry, and the TTL=0 "always regenerate"
 * behavior that disables caching entirely.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — defined before importing the module under test
// ---------------------------------------------------------------------------

const checkpointStore = new Map<string, string>();

mock.module("../persistence/checkpoints.js", () => ({
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpointStore.set(key, value);
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  getCachedEmptyStateGreeting,
  setCachedEmptyStateGreeting,
} from "../runtime/routes/empty-state-greeting-cache.js";
import { setConfig } from "./helpers/set-config.js";

/** Seed the cache TTL into the real workspace config. */
function setCacheTtlMs(ttlMs: number): void {
  setConfig("ui", { emptyStateGreetingCacheTtlMs: ttlMs });
}

const TIMESTAMP_KEY = "empty_state:greeting:cached_at";

beforeEach(() => {
  setCacheTtlMs(4 * 60 * 60 * 1000);
});

afterEach(() => {
  checkpointStore.clear();
});

describe("empty-state greeting cache", () => {
  test("returns null when the cache is empty", () => {
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("round-trips set then get within the TTL", () => {
    setCachedEmptyStateGreeting("hey there");
    expect(getCachedEmptyStateGreeting()).toBe("hey there");
  });

  test("keeps cached greetings separate by timezone scope", () => {
    setCachedEmptyStateGreeting("hey eastern", "America/New_York");
    setCachedEmptyStateGreeting("hey central", "America/Chicago");

    expect(getCachedEmptyStateGreeting("America/New_York")).toBe("hey eastern");
    expect(getCachedEmptyStateGreeting("America/Chicago")).toBe("hey central");
    expect(getCachedEmptyStateGreeting("Europe/Skopje")).toBeNull();
  });

  test("returns null once the TTL is exceeded", () => {
    setCachedEmptyStateGreeting("stale");
    checkpointStore.set(
      TIMESTAMP_KEY,
      String(Date.now() - (4 * 60 + 1) * 60 * 1000),
    );
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("returns the cached value just within the TTL", () => {
    setCachedEmptyStateGreeting("fresh enough");
    checkpointStore.set(
      TIMESTAMP_KEY,
      String(Date.now() - (3 * 60 + 59) * 60 * 1000),
    );
    expect(getCachedEmptyStateGreeting()).toBe("fresh enough");
  });

  test("TTL of 0 disables caching: writes are skipped and reads miss", () => {
    setCacheTtlMs(0);
    setCachedEmptyStateGreeting("should not persist");
    expect(checkpointStore.size).toBe(0);
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("TTL of 0 ignores a value cached while caching was enabled", () => {
    setCachedEmptyStateGreeting("cached while on");
    setCacheTtlMs(0);
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("returns null when the timestamp checkpoint is missing", () => {
    checkpointStore.set("empty_state:greeting:text", "orphaned");
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });
});
