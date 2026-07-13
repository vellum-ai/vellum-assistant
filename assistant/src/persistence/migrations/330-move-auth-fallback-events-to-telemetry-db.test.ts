/**
 * Tests for migration 330: relocating `auth_fallback_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`), covered
 * as the head of the full pipeline — migration 334 then backfills the
 * relocated rows into the generic `telemetry_events` outbox and drops the
 * telemetry-side table.
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran the pipeline once, so each test
 * recreates the pre-move source table in `main` to simulate an upgrading
 * install, then runs 330 + 334 directly.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateMoveAuthFallbackEventsToTelemetryDb } =
  await import("./330-move-auth-fallback-events-to-telemetry-db.js");
const { migrateBackfillTelemetryEventsOutbox } =
  await import("./334-backfill-telemetry-events-outbox.js");

await initializeDb();

const SOURCE_COLUMNS = `
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, guard TEXT NOT NULL,
  path TEXT NOT NULL, failure_kind TEXT NOT NULL, count INTEGER NOT NULL,
  window_start INTEGER NOT NULL, window_end INTEGER NOT NULL`;

/** Backfilled outbox rows for the auth_fallback source, in `(created_at, id)` order. */
function outboxAuthFallbackRows(): Array<{
  id: string;
  payload: Record<string, unknown>;
}> {
  return (
    getTelemetrySqlite()!
      .query(
        `SELECT id, payload FROM telemetry_events
         WHERE name = 'auth_fallback' ORDER BY created_at, id`,
      )
      .all() as Array<{ id: string; payload: string }>
  ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

function existsInMain(name: string): boolean {
  return (
    getSqlite()
      .query(
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(name) != null
  );
}

function existsInTelemetry(name: string): boolean {
  return (
    getTelemetrySqlite()!
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) != null
  );
}

function resetState(): void {
  getTelemetrySqlite()!.exec(`DROP TABLE IF EXISTS auth_fallback_events`);
  getTelemetrySqlite()!.exec(
    `DELETE FROM telemetry_events WHERE name = 'auth_fallback'`,
  );
  getTelemetrySqlite()!.exec(
    `DELETE FROM flush_checkpoints WHERE key LIKE 'telemetry:auth_fallback:%'`,
  );
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

async function runPipeline(): Promise<void> {
  await migrateMoveAuthFallbackEventsToTelemetryDb(getDb());
  migrateBackfillTelemetryEventsOutbox(getDb());
}

describe("migration 330: move auth_fallback_events to the telemetry DB", () => {
  test("pre-move rows land in telemetry_events and both legacy tables are gone", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);
    expect(existsInTelemetry("auth_fallback_events")).toBe(false);

    const rows = outboxAuthFallbackRows();
    expect(rows.map((r) => r.id)).toEqual(["seed-1", "seed-2", "seed-dupe"]);
    expect(rows[0]!.payload).toMatchObject({
      type: "auth_fallback",
      daemon_event_id: "seed-1",
      recorded_at: 1000,
      guard: "edge",
      path: "/v1/messages",
      failure_kind: "missing_authorization",
      count: 7,
      window_start: 900,
      window_end: 1000,
    });
    expect(rows[2]!.payload.guard).toBe("edge-guardian");
  });

  test("re-running the pipeline after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();
    await runPipeline();

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);
    expect(existsInTelemetry("auth_fallback_events")).toBe(false);
    expect(outboxAuthFallbackRows()).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the outbox does not fail the pipeline", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain/backfill batch's copy and delete re-copies the
    // same rows next boot; INSERT OR IGNORE must keep the already-copied row.
    getTelemetrySqlite()!.exec(
      `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload)
       VALUES ('seed-dupe', 'auth_fallback', 3000, NULL, '{"type":"auth_fallback","guard":"already-copied"}')`,
    );

    await runPipeline();

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);
    const rows = outboxAuthFallbackRows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === "seed-dupe")!.payload.guard).toBe(
      "already-copied",
    );
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(
      `CREATE TABLE main.auth_fallback_events (${SOURCE_COLUMNS})`,
    );

    await runPipeline();

    expect(existsInMain("auth_fallback_events")).toBe(false);
    expect(existsInMain("auth_fallback_events__relocating")).toBe(false);
    expect(outboxAuthFallbackRows()).toHaveLength(0);
  });
});
