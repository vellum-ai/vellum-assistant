import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../../schema.js";
import { type MigrationStep, runMigrationSteps } from "../run-migrations.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

describe("runMigrationSteps — checkpointing", () => {
  // Skipped: documents the post-checkpointing contract and fails against the
  // current behavior, which re-runs every forward step on every boot. Promote
  // to `test` when true checkpointing of initial migrations lands.
  test.skip("does not re-execute a step that was already applied on a prior run", () => {
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
});
