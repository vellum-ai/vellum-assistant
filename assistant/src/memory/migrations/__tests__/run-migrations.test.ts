import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import {
  clearMigrationStepCheckpoints,
  type MigrationStep,
  runMigrationSteps,
} from "../run-migrations.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

describe("runMigrationSteps — checkpointing", () => {
  test("does not re-execute a step that was already applied on a prior run", () => {
    /**
     * Booting an already-migrated database must not re-run forward migration
     * steps. With true checkpointing each step's body executes at most once
     * across boots; without it every step re-runs on every startup — the
     * ~200-step re-probe that floors daemon startup at ~30s.
     */

    // GIVEN three dummy migration steps that count how often their body runs
    const calls = { a: 0, b: 0, c: 0 };
    const steps: MigrationStep[] = [
      function dummyMigrationA() {
        calls.a++;
      },
      function dummyMigrationB() {
        calls.b++;
      },
      function dummyMigrationC() {
        calls.c++;
      },
    ];

    // AND a database that has already been migrated once
    const db = createTestDb();
    runMigrationSteps(db, steps);

    // WHEN the same steps run again against the already-migrated database
    runMigrationSteps(db, steps);

    // THEN no step body executes a second time
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
  });

  test("records step completions in the shared memory_checkpoints ledger", () => {
    /**
     * Step bookkeeping lives in the same memory_checkpoints table the registry
     * uses, under the `step:` namespace — one ledger for all applied state.
     */

    // GIVEN a single named step
    const db = createTestDb();
    runMigrationSteps(db, [
      function dummyMigrationA() {
        // no-op
      },
    ]);

    // THEN its completion is recorded under the step: namespace in memory_checkpoints
    const row = getSqliteFrom(db)
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'step:dummyMigrationA'`,
      )
      .get() as { value: string } | null;
    expect(row?.value).toBe("1");
  });

  test("runs a newly appended step on a later boot while skipping applied ones", () => {
    /**
     * Checkpointing must not block migrations added in a later release: an
     * already-applied step is skipped, but a brand-new step still runs.
     */

    // GIVEN a database already migrated with two steps
    const calls = { a: 0, b: 0, c: 0 };
    const stepA: MigrationStep = function dummyMigrationA() {
      calls.a++;
    };
    const stepB: MigrationStep = function dummyMigrationB() {
      calls.b++;
    };
    const db = createTestDb();
    runMigrationSteps(db, [stepA, stepB]);

    // AND a third step appended to the list
    const stepC: MigrationStep = function dummyMigrationC() {
      calls.c++;
    };

    // WHEN the expanded list runs against the already-migrated database
    runMigrationSteps(db, [stepA, stepB, stepC]);

    // THEN only the newly appended step executes
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
  });

  test("always re-runs steps named in alwaysRun", () => {
    /**
     * Crash recovery and registry aggregators must execute on every boot, so
     * steps in `alwaysRun` are never checkpointed and never skipped.
     */

    // GIVEN one checkpointed step and one always-run step
    const calls = { once: 0, always: 0 };
    const steps: MigrationStep[] = [
      function checkpointedStep() {
        calls.once++;
      },
      function alwaysRunStep() {
        calls.always++;
      },
    ];
    const db = createTestDb();
    const alwaysRun = new Set(["alwaysRunStep"]);
    runMigrationSteps(db, steps, { alwaysRun });

    // WHEN the same steps run again
    runMigrationSteps(db, steps, { alwaysRun });

    // THEN the checkpointed step runs once but the always-run step runs each boot
    expect(calls).toEqual({ once: 1, always: 2 });
  });

  test("does not checkpoint a failed step so it retries on the next boot", () => {
    /**
     * A step whose body throws is reported in `failed` and left uncheckpointed,
     * so the next boot retries it instead of silently skipping it.
     */

    // GIVEN a step that throws on its first run and succeeds afterwards
    const calls = { flaky: 0 };
    const steps: MigrationStep[] = [
      function flakyStep() {
        calls.flaky++;
        if (calls.flaky === 1) {
          throw new Error("transient failure");
        }
      },
    ];
    const db = createTestDb();
    const first = runMigrationSteps(db, steps);

    // AND the first run reports the failure
    expect(first.failed).toEqual(["flakyStep"]);

    // WHEN the step runs again on the next boot
    const second = runMigrationSteps(db, steps);

    // THEN it retries, succeeds, and is then checkpointed
    expect(calls.flaky).toBe(2);
    expect(second.failed).toEqual([]);
    expect(runMigrationSteps(db, steps).skipped).toEqual(["flakyStep"]);
  });

  test("clearMigrationStepCheckpoints forces every step to re-run", () => {
    /**
     * Clearing the step namespace (as rollback does) makes the next run
     * re-execute and re-record all steps.
     */

    // GIVEN a database migrated once
    const calls = { a: 0 };
    const steps: MigrationStep[] = [
      function dummyMigrationA() {
        calls.a++;
      },
    ];
    const db = createTestDb();
    runMigrationSteps(db, steps);
    expect(calls.a).toBe(1);

    // WHEN the step checkpoints are cleared
    clearMigrationStepCheckpoints(db);

    // THEN the next run re-executes the step
    runMigrationSteps(db, steps);
    expect(calls.a).toBe(2);
  });
});
