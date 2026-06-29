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

  test("defaults to DB ready outside lifecycle", () => {
    expect(isDbReady()).toBe(true);
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

  test("resetReadinessForTest restores default readiness", () => {
    setDbReady(false);
    setStartupComplete();
    resetReadinessForTest();
    expect(isDbReady()).toBe(true);
    expect(isStartupComplete()).toBe(false);
  });
});
