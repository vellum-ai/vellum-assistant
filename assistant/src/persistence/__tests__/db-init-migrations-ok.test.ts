/**
 * Tests for initializeDb()'s readiness-gating return contract.
 *
 * The daemon's readiness latch (setDbReady) is gated on initializeDb resolving
 * with migrationsOk:true, so a clean init must report all migrations applied.
 * Migration-step failures are caught-and-logged inside the runner (not thrown),
 * so the boolean is the only signal lifecycle has to keep /readyz unready on a
 * partially-migrated schema — see assistant/src/daemon/lifecycle.ts.
 */

import { describe, expect, test } from "bun:test";

import { initializeDb } from "../db-init.js";
import { migrationSteps } from "../steps.js";

describe("initializeDb — migrationsOk return contract", () => {
  test("resolves to { migrationsOk: true } on a clean init", async () => {
    const result = await initializeDb();
    expect(result).toEqual({ migrationsOk: true });
  });

  test("resolves to { migrationsOk: false } when a step is deferred", async () => {
    // initializeDb reads the shared migrationSteps array, so appending a step
    // whose dependsOn names a checkpoint that can never exist exercises the
    // real deferral path end-to-end. The step is deferred (never run, never
    // checkpointed), so removing it in finally leaves the ledger untouched.
    const syntheticStep = {
      name: "dbInitTestSyntheticDeferredStep",
      run: () => {
        throw new Error("deferred step must not run");
      },
      dependsOn: ["dbInitTestMissingPrerequisite"],
    };
    migrationSteps.push(syntheticStep);
    try {
      const result = await initializeDb();
      expect(result).toEqual({ migrationsOk: false });
    } finally {
      migrationSteps.splice(migrationSteps.indexOf(syntheticStep), 1);
    }

    // The deferred step wrote nothing to the ledger, so a clean re-init
    // reports ready again.
    expect(await initializeDb()).toEqual({ migrationsOk: true });
  });
});
