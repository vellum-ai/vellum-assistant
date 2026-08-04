import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

// The migration snapshots whatever the shared schedule helper resolves, so the
// helper is stubbed to drive both of its outcomes: a named profile and the
// code-owned anchor (null), which has no key to record.
let resolvedDefault: string | null = "balanced";
mock.module("../../schedule/inference-profile.js", () => ({
  resolveDefaultScheduleInferenceProfile: () => resolvedDefault,
}));

import * as schema from "../schema.js";
import { migrateBackfillScheduleInferenceProfile } from "./363-backfill-schedule-inference-profile.js";

function createTestDb(withProfileColumn = true) {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      next_run_at INTEGER NOT NULL${withProfileColumn ? ",\n      inference_profile TEXT" : ""}
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertJob(
  sqlite: Database,
  id: string,
  inferenceProfile: string | null,
): void {
  sqlite
    .query(
      "INSERT INTO cron_jobs (id, name, message, next_run_at, inference_profile) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, id, "hi", 1000, inferenceProfile);
}

function profileOf(sqlite: Database, id: string): unknown {
  return (
    sqlite
      .query("SELECT inference_profile FROM cron_jobs WHERE id = ?")
      .get(id) as { inference_profile: unknown }
  ).inference_profile;
}

describe("migration 363: backfill cron_jobs.inference_profile", () => {
  beforeEach(() => {
    resolvedDefault = "balanced";
  });

  test("pins unpinned rows to the resolved default", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "unpinned-1", null);
    insertJob(sqlite, "unpinned-2", null);

    migrateBackfillScheduleInferenceProfile(db);

    expect(profileOf(sqlite, "unpinned-1")).toBe("balanced");
    expect(profileOf(sqlite, "unpinned-2")).toBe("balanced");
  });

  test("leaves an existing pin alone", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "pinned", "cost-optimized");

    migrateBackfillScheduleInferenceProfile(db);

    expect(profileOf(sqlite, "pinned")).toBe("cost-optimized");
  });

  test("is idempotent: a second run changes nothing", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "unpinned", null);

    migrateBackfillScheduleInferenceProfile(db);
    resolvedDefault = "cost-optimized";
    migrateBackfillScheduleInferenceProfile(db);

    // The row was pinned by the first run, so the later default does not
    // overwrite it. That is what makes a schedule's cost stable.
    expect(profileOf(sqlite, "unpinned")).toBe("balanced");
  });

  test("leaves rows null when no named profile resolves", () => {
    const { sqlite, db } = createTestDb();
    insertJob(sqlite, "unpinned", null);
    resolvedDefault = null;

    migrateBackfillScheduleInferenceProfile(db);

    expect(profileOf(sqlite, "unpinned")).toBeNull();
  });

  test("skips an install that has no inference_profile column yet", () => {
    const { sqlite, db } = createTestDb(false);
    sqlite
      .query(
        "INSERT INTO cron_jobs (id, name, message, next_run_at) VALUES ('legacy', 'legacy', 'hi', 1000)",
      )
      .run();

    expect(() => migrateBackfillScheduleInferenceProfile(db)).not.toThrow();
  });
});
