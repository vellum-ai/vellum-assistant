/**
 * Tests for migration 330: relocating `auth_fallback_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`).
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran migration 330 once (dropping the empty
 * main-side table created by migration 271), so each test recreates the
 * pre-move source table in `main` to simulate an upgrading install.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { queryUnreportedAuthFallbackEvents } =
  await import("../../security/auth-fallback-events-store.js");
const { migrateMoveAuthFallbackEventsToTelemetryDb } =
  await import("./330-move-auth-fallback-events-to-telemetry-db.js");

await initializeDb();

const SOURCE_COLUMNS = `
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, guard TEXT NOT NULL,
  path TEXT NOT NULL, failure_kind TEXT NOT NULL, count INTEGER NOT NULL,
  window_start INTEGER NOT NULL, window_end INTEGER NOT NULL`;

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
  getTelemetrySqlite()!.exec(`DELETE FROM auth_fallback_events`);
  getSqlite().exec(`DROP TABLE IF EXISTS main.auth_fallback_events`);
  getSqlite().exec(
    `DROP TABLE IF EXISTS main."auth_fallback_events__relocating"`,
  );
}

function seedSourceTable(): void {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE main.auth_fallback_events (${SOURCE_COLUMNS})`);
  const insert = sqlite.prepare(
    `INSERT INTO main.auth_fallback_events
       (id, created_at, guard, path, failure_kind, count, window_start, window_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    "seed-1",
    1000,
    "edge",
    "/v1/messages",
    "missing_authorization",
    7,
    900,
    1000,
  );
  insert.run(
    "seed-2",
    2000,
    "edge-scoped",
    "/v1/files",
    "insufficient_scope",
    2,
    1900,
    2000,
  );
  insert.run(
    "seed-dupe",
    3000,
    "edge-guardian",
    "/v1/pair",
    "guardian_mismatch",
    1,
    2900,
    3000,
  );
}

describe("migration 330: move auth_fallback_events to the telemetry DB", () => {
  test("drains pre-move rows into the telemetry DB and drops the main-side table", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveAuthFallbackEventsToTelemetryDb(getDb());

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);

    const moved = getTelemetrySqlite()!
      .query(`SELECT id, guard FROM auth_fallback_events ORDER BY id`)
      .all();
    expect(moved).toEqual([
      { id: "seed-1", guard: "edge" },
      { id: "seed-2", guard: "edge-scoped" },
      { id: "seed-dupe", guard: "edge-guardian" },
    ]);

    // The relocated rows are readable through the store's reporter query.
    const rows = queryUnreportedAuthFallbackEvents(0, undefined, 10);
    expect(rows.map((r) => r.id)).toEqual(["seed-1", "seed-2", "seed-dupe"]);
    expect(rows[0]!).toMatchObject({
      guard: "edge",
      path: "/v1/messages",
      failureKind: "missing_authorization",
      count: 7,
      windowStart: 900,
      windowEnd: 1000,
    });
  });

  test("re-running after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveAuthFallbackEventsToTelemetryDb(getDb());
    await migrateMoveAuthFallbackEventsToTelemetryDb(getDb());

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);
    expect(queryUnreportedAuthFallbackEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the telemetry copy does not fail the drain", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain batch's copy and delete re-copies the same rows
    // next boot; INSERT OR IGNORE must keep the already-copied row and finish.
    getTelemetrySqlite()!.exec(
      `INSERT INTO auth_fallback_events
         (id, created_at, guard, path, failure_kind, count, window_start, window_end)
       VALUES ('seed-dupe', 3000, 'already-copied', '/v1/pair', 'guardian_mismatch', 1, 2900, 3000)`,
    );

    await migrateMoveAuthFallbackEventsToTelemetryDb(getDb());

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);
    const dupe = getTelemetrySqlite()!
      .query(`SELECT guard FROM auth_fallback_events WHERE id = 'seed-dupe'`)
      .get() as { guard: string };
    expect(dupe.guard).toBe("already-copied");
    expect(queryUnreportedAuthFallbackEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(
      `CREATE TABLE main.auth_fallback_events (${SOURCE_COLUMNS})`,
    );

    await migrateMoveAuthFallbackEventsToTelemetryDb(getDb());

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);
    expect(queryUnreportedAuthFallbackEvents(0, undefined, 10)).toHaveLength(0);
  });

  test("telemetry-side schema has the reporter's compound cursor index", () => {
    const indexes = (
      getTelemetrySqlite()!
        .query(`PRAGMA index_list(auth_fallback_events)`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_auth_fallback_events_created_at_id");
  });
});
