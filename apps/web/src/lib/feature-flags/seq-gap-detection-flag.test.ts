/**
 * Tests for the client-side seq-gap-detection dev flag.
 *
 * The flag is a localStorage override with no server targeting, so its
 * default value is what every client gets. These tests pin the default
 * to disabled and verify the explicit enable/disable/clear round-trip.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  isSeqGapDetectionEnabled,
  setSeqGapDetectionEnabled,
} from "@/lib/feature-flags/seq-gap-detection-flag";

const STORAGE_KEY = "vellum:debug:seqGapDetection";

describe("seq-gap-detection-flag", () => {
  let originalReload: typeof window.location.reload;
  let reloadCalls: number;

  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    reloadCalls = 0;
    // location.reload is non-configurable in jsdom — replace at the
    // descriptor level so we can count calls without actually
    // reloading the test process.
    originalReload = window.location.reload;
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: mock(() => {
        reloadCalls += 1;
      }),
    });
  });

  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: originalReload,
    });
  });

  test("is disabled by default when no override is set", () => {
    // GIVEN no override has been written to localStorage

    // WHEN the flag is read
    const enabled = isSeqGapDetectionEnabled();

    // THEN it reports disabled — the safe default for all clients
    expect(enabled).toBe(false);
  });

  test("explicit true enables the flag and triggers reload", () => {
    // GIVEN no override is set

    // WHEN the flag is explicitly enabled
    const result = setSeqGapDetectionEnabled(true);

    // THEN the post-reload value is enabled and persisted
    expect(result).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(reloadCalls).toBe(1);
    // AND a subsequent read reflects the override
    expect(isSeqGapDetectionEnabled()).toBe(true);
  });

  test("explicit false disables the flag and triggers reload", () => {
    // GIVEN the flag was previously enabled
    window.localStorage.setItem(STORAGE_KEY, "true");

    // WHEN the flag is explicitly disabled
    const result = setSeqGapDetectionEnabled(false);

    // THEN the post-reload value is disabled and persisted
    expect(result).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");
    expect(reloadCalls).toBe(1);
    expect(isSeqGapDetectionEnabled()).toBe(false);
  });

  test("clearing the override reverts to the disabled default", () => {
    // GIVEN the flag was explicitly enabled
    window.localStorage.setItem(STORAGE_KEY, "true");

    // WHEN the override is cleared
    const result = setSeqGapDetectionEnabled(null);

    // THEN the effective value falls back to the disabled default
    expect(result).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(reloadCalls).toBe(1);
    expect(isSeqGapDetectionEnabled()).toBe(false);
  });

  test("undefined arg is inspect-only — no reload, no mutation", () => {
    // GIVEN an explicit override is set
    window.localStorage.setItem(STORAGE_KEY, "true");

    // WHEN the flag is read in inspect-only mode
    const result = setSeqGapDetectionEnabled();

    // THEN the current value is returned without reloading or mutating
    expect(result).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");
    expect(reloadCalls).toBe(0);
  });
});
