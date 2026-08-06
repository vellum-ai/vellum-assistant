/**
 * The quiesce lease is the safety-critical piece of `vellum sleep --wait`:
 * a stuck or misread lease would silently pause heartbeats, schedules, and
 * memory jobs. These tests pin the fail-open contract (missing, malformed,
 * or expired lease reads as "not quiesced") and the TTL clamps.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { setMemoryCheckpoint } from "../checkpoints.js";
import { initializeDb } from "../db-init.js";
import {
  clearLifecycleQuiesce,
  DEFAULT_QUIESCE_TTL_MS,
  getLifecycleQuiesceUntil,
  isLifecycleQuiesced,
  MAX_QUIESCE_TTL_MS,
  MIN_QUIESCE_TTL_MS,
  setLifecycleQuiesce,
} from "../lifecycle-quiesce.js";
import { resetTestTables } from "../raw-query.js";

const QUIESCE_KEY = "lifecycle:quiesce_until";

await initializeDb();

beforeEach(() => {
  resetTestTables("memory_checkpoints");
});

describe("lifecycle-quiesce", () => {
  test("no lease reads as not quiesced (fail-open default)", () => {
    expect(isLifecycleQuiesced()).toBe(false);
    expect(getLifecycleQuiesceUntil()).toBeNull();
  });

  test("setLifecycleQuiesce arms the lease for the requested TTL", () => {
    const before = Date.now();
    const until = setLifecycleQuiesce(DEFAULT_QUIESCE_TTL_MS);
    expect(until).toBeGreaterThanOrEqual(before + DEFAULT_QUIESCE_TTL_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + DEFAULT_QUIESCE_TTL_MS);
    expect(isLifecycleQuiesced()).toBe(true);
    expect(getLifecycleQuiesceUntil()).toBe(until);
  });

  test("TTL is clamped to the sane range", () => {
    const beforeMin = Date.now();
    const untilMin = setLifecycleQuiesce(1);
    expect(untilMin).toBeGreaterThanOrEqual(beforeMin + MIN_QUIESCE_TTL_MS);

    const beforeMax = Date.now();
    const untilMax = setLifecycleQuiesce(Number.MAX_SAFE_INTEGER);
    expect(untilMax).toBeLessThanOrEqual(
      Date.now() + MAX_QUIESCE_TTL_MS + 1_000,
    );
    expect(untilMax).toBeGreaterThanOrEqual(beforeMax + MAX_QUIESCE_TTL_MS);
  });

  test("re-arming extends the lease (refresh semantics)", () => {
    const first = setLifecycleQuiesce(MIN_QUIESCE_TTL_MS);
    const second = setLifecycleQuiesce(MAX_QUIESCE_TTL_MS);
    expect(second).toBeGreaterThan(first);
    expect(getLifecycleQuiesceUntil()).toBe(second);
  });

  test("an expired lease reads as not quiesced", () => {
    setMemoryCheckpoint(QUIESCE_KEY, String(Date.now() - 1));
    expect(isLifecycleQuiesced()).toBe(false);
    expect(getLifecycleQuiesceUntil()).toBeNull();
  });

  test("a malformed lease value reads as not quiesced (fail-open)", () => {
    setMemoryCheckpoint(QUIESCE_KEY, "not-a-number");
    expect(isLifecycleQuiesced()).toBe(false);
  });

  test("clearLifecycleQuiesce releases an active lease", () => {
    setLifecycleQuiesce(DEFAULT_QUIESCE_TTL_MS);
    expect(isLifecycleQuiesced()).toBe(true);
    clearLifecycleQuiesce();
    expect(isLifecycleQuiesced()).toBe(false);
  });
});
