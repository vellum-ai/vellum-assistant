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
  test("does not re-execute a step that was already applied on a prior run", async () => {
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
    await runMigrationSteps(db, steps);

    // WHEN the same steps run again against the already-migrated database
    await runMigrationSteps(db, steps);

    // THEN no step body executes a second time
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
  });

  test("records step completions in the shared memory_checkpoints ledger", async () => {
    /**
     * Step bookkeeping lives in the same memory_checkpoints table the step runner
     * uses, under the `step:` namespace — one ledger for all applied state.
     */

    // GIVEN a single named step
    const db = createTestDb();
    await runMigrationSteps(db, [
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

  test("runs a newly appended step on a later boot while skipping applied ones", async () => {
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
    await runMigrationSteps(db, [stepA, stepB]);

    // AND a third step appended to the list
    const stepC: MigrationStep = function dummyMigrationC() {
      calls.c++;
    };

    // WHEN the expanded list runs against the already-migrated database
    await runMigrationSteps(db, [stepA, stepB, stepC]);

    // THEN only the newly appended step executes
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
  });

  test("recovers crashed migrations before running steps", async () => {
    /**
     * runMigrationSteps clears stalled `started`/`rolling_back` checkpoints
     * before the loop so a migration interrupted mid-flight re-runs this boot.
     */

    // GIVEN a database with a stalled step checkpoint left by a crash
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    raw.run(
      `CREATE TABLE IF NOT EXISTS memory_checkpoints (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
    raw.run(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('migration_stalled_v1', 'started', 0)`,
    );

    // WHEN the runner executes
    await runMigrationSteps(db, [
      function dummyMigrationA() {
        // no-op
      },
    ]);

    // THEN the stalled checkpoint has been cleared so its migration can re-run
    const row = raw
      .query(
        `SELECT 1 FROM memory_checkpoints WHERE key = 'migration_stalled_v1'`,
      )
      .get();
    expect(row).toBeNull();
  });

  test("does not checkpoint a failed step so it retries on the next boot", async () => {
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
    const first = await runMigrationSteps(db, steps);

    // AND the first run reports the failure
    expect(first.failed).toEqual(["flakyStep"]);

    // WHEN the step runs again on the next boot
    const second = await runMigrationSteps(db, steps);

    // THEN it retries, succeeds, and is then checkpointed
    expect(calls.flaky).toBe(2);
    expect(second.failed).toEqual([]);
    expect((await runMigrationSteps(db, steps)).skipped).toEqual(["flakyStep"]);
  });

  test("clearMigrationStepCheckpoints forces every step to re-run", async () => {
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
    await runMigrationSteps(db, steps);
    expect(calls.a).toBe(1);

    // WHEN the step checkpoints are cleared
    clearMigrationStepCheckpoints(db);

    // THEN the next run re-executes the step
    await runMigrationSteps(db, steps);
    expect(calls.a).toBe(2);
  });

  test("awaits an async step to completion before running or checkpointing the next", async () => {
    /**
     * An async step must be fully drained before the runner advances: ordering
     * is the invariant later migrations rely on (step N+1 may assume N's result
     * is true), and the step is checkpointed only after its promise resolves so
     * a crash mid-drain leaves it uncheckpointed and retryable rather than
     * recorded as done.
     */

    // GIVEN an async step that records its completion order only after yielding,
    // followed by a sync step that records when it starts
    const order: string[] = [];
    const steps: MigrationStep[] = [
      async function asyncDrainStep() {
        await Promise.resolve();
        order.push("async-done");
      },
      function followingStep() {
        order.push("following-start");
      },
    ];
    const db = createTestDb();

    // WHEN the runner executes both steps
    const result = await runMigrationSteps(db, steps);

    // THEN the async step finishes before the next step starts
    expect(order).toEqual(["async-done", "following-start"]);

    // AND both steps are checkpointed, so a later boot skips them
    expect(result.failed).toEqual([]);
    expect((await runMigrationSteps(db, steps)).skipped).toEqual([
      "asyncDrainStep",
      "followingStep",
    ]);
  });

  test("a rejected async step is reported failed and left uncheckpointed", async () => {
    /**
     * A step whose promise rejects must be treated exactly like a synchronous
     * throw: reported in `failed`, not checkpointed, and retried next boot.
     */

    // GIVEN an async step that rejects on its first run and resolves afterwards
    const calls = { flaky: 0 };
    const steps: MigrationStep[] = [
      async function flakyAsyncStep() {
        calls.flaky++;
        await Promise.resolve();
        if (calls.flaky === 1) {
          throw new Error("transient async failure");
        }
      },
    ];
    const db = createTestDb();

    // WHEN it runs and rejects
    const first = await runMigrationSteps(db, steps);

    // THEN the rejection is reported and the step is not checkpointed
    expect(first.failed).toEqual(["flakyAsyncStep"]);

    // WHEN it runs again on the next boot
    const second = await runMigrationSteps(db, steps);

    // THEN it retries, resolves, and is then checkpointed
    expect(calls.flaky).toBe(2);
    expect(second.failed).toEqual([]);
    expect((await runMigrationSteps(db, steps)).skipped).toEqual([
      "flakyAsyncStep",
    ]);
  });

  test("detects and recovers step-level 'started' markers from a prior crash", async () => {
    /**
     * If the process crashes mid-step, the runner leaves a `step:<name>` =
     * 'started' checkpoint. On the next boot, recoverCrashedMigrations
     * detects it, clears it, and the step re-runs.
     */

    // GIVEN a database with a stalled step: checkpoint left by a crash
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    raw.run(
      `CREATE TABLE IF NOT EXISTS memory_checkpoints (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
    raw.run(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('step:crashedStep', 'started', 0)`,
    );

    let ran = false;
    const steps: MigrationStep[] = [
      function crashedStep() {
        ran = true;
      },
    ];

    // WHEN the runner executes — recoverCrashedMigrations should clear
    // the 'started' marker and let the step run.
    await runMigrationSteps(db, steps);

    // THEN the stalled checkpoint was cleared and the step ran
    expect(ran).toBe(true);
    const stalled = raw
      .query(
        `SELECT 1 FROM memory_checkpoints WHERE key = 'step:crashedStep' AND value = 'started'`,
      )
      .get();
    expect(stalled).toBeNull();
    // And the step was checkpointed as '1' (completed)
    const completed = raw
      .query(
        `SELECT 1 FROM memory_checkpoints WHERE key = 'step:crashedStep' AND value = '1'`,
      )
      .get();
    expect(completed).not.toBeNull();
  });

  test("does not skip a step whose only checkpoint is 'started' (not '1')", async () => {
    /**
     * The skip query filters for value = '1', so a 'started' marker
     * alone must not cause a step to be skipped — the step should run.
     * (recoverCrashedMigrations clears 'started' markers first, but
     * even if it didn't, the skip logic is independent and correct.)
     */

    const db = createTestDb();
    const raw = getSqliteFrom(db);
    raw.run(
      `CREATE TABLE IF NOT EXISTS memory_checkpoints (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    );
    // Insert a 'started' marker without running recoverCrashedMigrations.
    // We simulate this by inserting directly and checking the applied set.
    raw.run(
      `INSERT INTO memory_checkpoints (key, value, updated_at) VALUES ('step:someStep', 'started', 0)`,
    );

    let ran = false;
    const steps: MigrationStep[] = [
      function someStep() {
        ran = true;
      },
    ];

    // WHEN the runner executes, recoverCrashedMigrations clears the
    // 'started' marker, so the step is not in the applied set and runs.
    const result = await runMigrationSteps(db, steps);

    // THEN the step ran (was not skipped)
    expect(ran).toBe(true);
    expect(result.applied).toEqual(["someStep"]);
    expect(result.skipped).toEqual([]);
  });

  test("writes 'started' marker before running each step", async () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    const seen: { marker: string | null } = { marker: null };
    const steps: MigrationStep[] = [
      async function asyncWithInspection() {
        const row = raw
          .query<
            { value: string },
            []
          >(`SELECT value FROM memory_checkpoints WHERE key = 'step:asyncWithInspection'`)
          .get();
        seen.marker = row?.value ?? null;
        await Promise.resolve();
      },
    ];

    await runMigrationSteps(db, steps);

    // The 'started' marker was visible during the async step's execution
    expect(seen.marker).toBe("started");

    const final = raw
      .query<
        { value: string },
        []
      >(`SELECT value FROM memory_checkpoints WHERE key = 'step:asyncWithInspection'`)
      .get();
    expect(final?.value).toBe("1");
  });
});
