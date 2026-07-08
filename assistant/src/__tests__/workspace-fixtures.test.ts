/**
 * Guards the per-test workspace-fixture machinery (test-preload seeding + the
 * `useEmptyWorkspace()` opt-out).
 *
 * The preload copies the migrated fixture into this process's workspace, so the
 * DB is already migrated before `initializeDb()` runs; `useEmptyWorkspace()`
 * drops it so a full migration rebuilds from scratch. Both paths must leave a
 * migrated, queryable DB.
 */

import { existsSync } from "node:fs";
import { afterAll, describe, expect, test } from "bun:test";

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawGet } from "../persistence/raw-query.js";
import { getDbPath } from "../util/platform.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { useEmptyWorkspace } from "./workspace-fixtures.js";

afterAll(() => {
  resetDbForTesting();
});

describe("workspace fixtures", () => {
  test("default workspace resolves to a migrated DB (fixture b)", async () => {
    // Under the runner the preload pre-copies the migrated fixture, so the DB
    // file exists before initializeDb() and the migration runner no-ops. In a
    // lone `bun test <file>` (no fixture env) initializeDb() runs the full
    // chain. Either way the end state is a migrated, queryable DB.
    if (process.env.VELLUM_TEST_MIGRATED_FIXTURE_DIR) {
      expect(existsSync(getDbPath())).toBe(true);
    }

    const result = await initializeDb();
    expect(result).toEqual({ migrationsOk: true });

    // A table created by the migration chain is present and queryable.
    const row = rawGet<{ n: number }>(
      "test:count-conversations",
      "SELECT COUNT(*) AS n FROM conversations",
    );
    expect(row?.n).toBe(0);
    expect(getDb()).toBeDefined();
  });

  test("useEmptyWorkspace() clears the DB, then a full migration rebuilds it (fixture a)", async () => {
    resetDbForTesting();
    useEmptyWorkspace();
    expect(existsSync(getDbPath())).toBe(false);

    const result = await initializeDb();
    expect(result).toEqual({ migrationsOk: true });
    expect(existsSync(getDbPath())).toBe(true);

    const row = rawGet<{ n: number }>(
      "test:count-conversations-rebuilt",
      "SELECT COUNT(*) AS n FROM conversations",
    );
    expect(row?.n).toBe(0);
  });
});
