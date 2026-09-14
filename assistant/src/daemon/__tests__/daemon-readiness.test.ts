import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getDbMigrationReadiness,
  isDbMigrationGateBypassed,
  isStartupComplete,
  resetReadinessForTest,
  setDbMigrating,
  setDbMigrationFailed,
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
    expect(getDbMigrationReadiness().ready).toBe(true);
    expect(isStartupComplete()).toBe(false);
  });

  test("setDbReady flips state both ways", () => {
    setDbReady(true);
    expect(getDbMigrationReadiness().ready).toBe(true);
    setDbReady(false);
    expect(getDbMigrationReadiness().ready).toBe(false);
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
    expect(getDbMigrationReadiness().ready).toBe(true);
    expect(isStartupComplete()).toBe(false);
  });

  test("setDbMigrationFailed records failed and deferred step details", () => {
    setDbMigrationFailed(new Error("boom"), {
      failedMigrations: [{ name: "flakyStep", error: "transient failure" }],
      deferredMigrations: [{ name: "dependentStep", missing: ["flakyStep"] }],
      validationError: "schema mismatch",
    });
    const readiness = getDbMigrationReadiness();
    expect(readiness).toMatchObject({
      ready: false,
      state: "failed",
      error: "boom",
      failedMigrations: [{ name: "flakyStep", error: "transient failure" }],
      deferredMigrations: [{ name: "dependentStep", missing: ["flakyStep"] }],
      validationError: "schema mismatch",
    });
  });

  test("debug/database bypasses the migration gate in every unready state", () => {
    setDbMigrating();
    expect(isDbMigrationGateBypassed("debug/database")).toBe(true);
    expect(isDbMigrationGateBypassed("debug_database")).toBe(true);
    expect(isDbMigrationGateBypassed("conversations")).toBe(false);

    setDbMigrationFailed(new Error("boom"));
    expect(isDbMigrationGateBypassed("debug/database")).toBe(true);
    expect(isDbMigrationGateBypassed("debug_database")).toBe(true);
    expect(isDbMigrationGateBypassed("conversations")).toBe(false);
  });
});
