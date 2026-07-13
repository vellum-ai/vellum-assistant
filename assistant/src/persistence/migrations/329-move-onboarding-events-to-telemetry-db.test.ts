/**
 * Tests for migration 329: relocating `onboarding_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`).
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran migration 329 once (dropping the empty
 * main-side table created by migration 248), so each test recreates the
 * pre-move source table in `main` to simulate an upgrading install.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { queryUnreportedOnboardingEvents } =
  await import("../../onboarding/onboarding-events-store.js");
const { migrateMoveOnboardingEventsToTelemetryDb } =
  await import("./329-move-onboarding-events-to-telemetry-db.js");

await initializeDb();

const SOURCE_COLUMNS = `
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, screen TEXT NOT NULL,
  tools_json TEXT, tasks_json TEXT, tone TEXT, google_connected INTEGER,
  google_scopes_json TEXT, prior_assistants_json TEXT, ab_variant TEXT,
  session_id TEXT, step_name TEXT, step_index INTEGER, completed_at TEXT,
  funnel_version TEXT`;

function existsInMain(name: string): boolean {
  return (
    getSqlite()
      .query(
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(name) != null
  );
}

function resetState(): void {
  getTelemetrySqlite()!.exec(`DELETE FROM onboarding_events`);
  getSqlite().exec(`DROP TABLE IF EXISTS main.onboarding_events`);
  getSqlite().exec(`DROP TABLE IF EXISTS main."onboarding_events__relocating"`);
}

function seedSourceTable(): void {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE main.onboarding_events (${SOURCE_COLUMNS})`);
  const insert = sqlite.prepare(
    `INSERT INTO main.onboarding_events
       (id, created_at, screen, session_id, step_name, step_index)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("seed-1", 1000, "tools", "conv-1", null, null);
  insert.run(
    "seed-2",
    2000,
    "activation_moment_1_complete",
    "conv-2",
    "activation_moment_1_complete",
    1,
  );
  insert.run("seed-dupe", 3000, "tasks", "conv-3", null, null);
}

describe("migration 329: move onboarding_events to the telemetry DB", () => {
  test("drains pre-move rows into the telemetry DB and drops the main-side table", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveOnboardingEventsToTelemetryDb(getDb());

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);

    const moved = getTelemetrySqlite()!
      .query(`SELECT id, screen FROM onboarding_events ORDER BY id`)
      .all();
    expect(moved).toEqual([
      { id: "seed-1", screen: "tools" },
      { id: "seed-2", screen: "activation_moment_1_complete" },
      { id: "seed-dupe", screen: "tasks" },
    ]);

    // The relocated rows are readable through the store's reporter query.
    const rows = queryUnreportedOnboardingEvents(0, undefined, 10);
    expect(rows.map((r) => r.id)).toEqual(["seed-1", "seed-2", "seed-dupe"]);
    expect(rows[1]!.stepName).toBe("activation_moment_1_complete");
    expect(rows[1]!.stepIndex).toBe(1);
  });

  test("re-running after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveOnboardingEventsToTelemetryDb(getDb());
    await migrateMoveOnboardingEventsToTelemetryDb(getDb());

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the telemetry copy does not fail the drain", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain batch's copy and delete re-copies the same rows
    // next boot; INSERT OR IGNORE must keep the already-copied row and finish.
    getTelemetrySqlite()!.exec(
      `INSERT INTO onboarding_events (id, created_at, screen)
       VALUES ('seed-dupe', 3000, 'already-copied')`,
    );

    await migrateMoveOnboardingEventsToTelemetryDb(getDb());

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);
    const dupe = getTelemetrySqlite()!
      .query(`SELECT screen FROM onboarding_events WHERE id = 'seed-dupe'`)
      .get() as { screen: string };
    expect(dupe.screen).toBe("already-copied");
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(`CREATE TABLE main.onboarding_events (${SOURCE_COLUMNS})`);

    await migrateMoveOnboardingEventsToTelemetryDb(getDb());

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);
    expect(queryUnreportedOnboardingEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("telemetry-side schema has the reporter's compound cursor index", () => {
    const indexes = (
      getTelemetrySqlite()!
        .query(`PRAGMA index_list(onboarding_events)`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_onboarding_events_created_at_id");
  });
});
