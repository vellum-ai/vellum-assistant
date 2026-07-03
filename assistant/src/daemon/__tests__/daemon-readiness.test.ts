import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isDbReady,
  isStartupComplete,
  resetReadinessForTest,
  setDbReady,
  setStartupComplete,
} from "../daemon-readiness.js";

describe("daemon-readiness", () => {
  beforeEach(() => {
    resetReadinessForTest();
  });

  afterEach(() => {
    resetReadinessForTest();
  });

  test("defaults are false", () => {
    expect(isDbReady()).toBe(false);
    expect(isStartupComplete()).toBe(false);
  });

  test("setDbReady flips state both ways", () => {
    setDbReady(true);
    expect(isDbReady()).toBe(true);
    setDbReady(false);
    expect(isDbReady()).toBe(false);
  });

  test("setStartupComplete latches startup state", () => {
    expect(isStartupComplete()).toBe(false);
    setStartupComplete();
    expect(isStartupComplete()).toBe(true);
  });

  test("setStartupComplete is monotonic", () => {
    setStartupComplete();
    setStartupComplete();
    expect(isStartupComplete()).toBe(true);
  });

  test("resetReadinessForTest clears both latches", () => {
    setDbReady(true);
    setStartupComplete();
    resetReadinessForTest();
    expect(isDbReady()).toBe(false);
    expect(isStartupComplete()).toBe(false);
  });
});
