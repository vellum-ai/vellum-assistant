/**
 * Tests for migration 329: relocating `lifecycle_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`).
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran migration 329 once (dropping the empty
 * main-side table created by migration 175), so each test recreates the
 * pre-move source table in `main` to simulate an upgrading install.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { queryUnreportedLifecycleEvents } =
  await import("../lifecycle-events-store.js");
const { migrateMoveLifecycleEventsToTelemetryDb } =
  await import("./329-move-lifecycle-events-to-telemetry-db.js");

await initializeDb();

const SOURCE_COLUMNS = `
  id TEXT PRIMARY KEY, event_name TEXT NOT NULL, created_at INTEGER NOT NULL`;

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
  getTelemetrySqlite()!.exec(`DELETE FROM lifecycle_events`);
  getSqlite().exec(`DROP TABLE IF EXISTS main.lifecycle_events`);
  getSqlite().exec(`DROP TABLE IF EXISTS main."lifecycle_events__relocating"`);
}

function seedSourceTable(): void {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE main.lifecycle_events (${SOURCE_COLUMNS})`);
  const insert = sqlite.prepare(
    `INSERT INTO main.lifecycle_events (id, event_name, created_at)
     VALUES (?, ?, ?)`,
  );
  insert.run("seed-1", "app_open", 1000);
  insert.run("seed-2", "hatch", 2000);
  insert.run("seed-dupe", "conversations_clear_all", 3000);
}

describe("migration 329: move lifecycle_events to the telemetry DB", () => {
  test("drains pre-move rows into the telemetry DB and drops the main-side table", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveLifecycleEventsToTelemetryDb(getDb());

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);

    const moved = getTelemetrySqlite()!
      .query(`SELECT id, event_name FROM lifecycle_events ORDER BY id`)
      .all();
    expect(moved).toEqual([
      { id: "seed-1", event_name: "app_open" },
      { id: "seed-2", event_name: "hatch" },
      { id: "seed-dupe", event_name: "conversations_clear_all" },
    ]);

    // The relocated rows are readable through the store's reporter query.
    const rows = queryUnreportedLifecycleEvents(0, undefined, 10);
    expect(rows).toEqual([
      { id: "seed-1", eventName: "app_open", createdAt: 1000 },
      { id: "seed-2", eventName: "hatch", createdAt: 2000 },
      {
        id: "seed-dupe",
        eventName: "conversations_clear_all",
        createdAt: 3000,
      },
    ]);
  });

  test("re-running after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveLifecycleEventsToTelemetryDb(getDb());
    await migrateMoveLifecycleEventsToTelemetryDb(getDb());

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);
    expect(queryUnreportedLifecycleEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the telemetry copy does not fail the drain", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain batch's copy and delete re-copies the same rows
    // next boot; INSERT OR IGNORE must keep the already-copied row and finish.
    getTelemetrySqlite()!.exec(
      `INSERT INTO lifecycle_events (id, event_name, created_at)
       VALUES ('seed-dupe', 'already-copied', 3000)`,
    );

    await migrateMoveLifecycleEventsToTelemetryDb(getDb());

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);
    const dupe = getTelemetrySqlite()!
      .query(`SELECT event_name FROM lifecycle_events WHERE id = 'seed-dupe'`)
      .get() as { event_name: string };
    expect(dupe.event_name).toBe("already-copied");
    expect(queryUnreportedLifecycleEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(`CREATE TABLE main.lifecycle_events (${SOURCE_COLUMNS})`);

    await migrateMoveLifecycleEventsToTelemetryDb(getDb());

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);
    expect(queryUnreportedLifecycleEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("telemetry-side schema has the reporter's compound cursor index", () => {
    const indexes = (
      getTelemetrySqlite()!
        .query(`PRAGMA index_list(lifecycle_events)`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_lifecycle_events_created_at_id");
  });
});
