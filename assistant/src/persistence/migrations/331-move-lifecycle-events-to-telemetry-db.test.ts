/**
 * Tests for migration 331: relocating `lifecycle_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`), covered
 * as the head of the full pipeline — migration 334 then backfills the
 * relocated rows into the generic `telemetry_events` outbox and drops the
 * telemetry-side table.
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran the pipeline once, so each test
 * recreates the pre-move source table in `main` to simulate an upgrading
 * install, then runs 331 + 334 directly.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateMoveLifecycleEventsToTelemetryDb } =
  await import("./331-move-lifecycle-events-to-telemetry-db.js");
const { migrateBackfillTelemetryEventsOutbox } =
  await import("./334-backfill-telemetry-events-outbox.js");

await initializeDb();

/** Backfilled outbox rows for the lifecycle source, in `(created_at, id)` order. */
function outboxLifecycleRows(): Array<{
  id: string;
  created_at: number;
  payload: Record<string, unknown>;
}> {
  return (
    getTelemetrySqlite()!
      .query(
        `SELECT id, created_at, payload FROM telemetry_events
         WHERE name = 'lifecycle' ORDER BY created_at, id`,
      )
      .all() as Array<{ id: string; created_at: number; payload: string }>
  ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

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

function existsInTelemetry(name: string): boolean {
  return (
    getTelemetrySqlite()!
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) != null
  );
}

function resetState(): void {
  getTelemetrySqlite()!.exec(`DROP TABLE IF EXISTS lifecycle_events`);
  getTelemetrySqlite()!.exec(
    `DELETE FROM telemetry_events WHERE name = 'lifecycle'`,
  );
  getTelemetrySqlite()!.exec(
    `DELETE FROM flush_checkpoints WHERE key LIKE 'telemetry:lifecycle:%'`,
  );
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

async function runPipeline(): Promise<void> {
  await migrateMoveLifecycleEventsToTelemetryDb(getDb());
  migrateBackfillTelemetryEventsOutbox(getDb());
}

describe("migration 331: move lifecycle_events to the telemetry DB", () => {
  test("pre-move rows land in telemetry_events and both legacy tables are gone", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);
    expect(existsInTelemetry("lifecycle_events")).toBe(false);

    const rows = outboxLifecycleRows();
    expect(rows.map((r) => r.id)).toEqual(["seed-1", "seed-2", "seed-dupe"]);
    expect(rows[0]!.payload).toMatchObject({
      type: "lifecycle",
      daemon_event_id: "seed-1",
      event_name: "app_open",
      recorded_at: 1000,
    });
    expect(rows[2]!.payload.event_name).toBe("conversations_clear_all");
  });

  test("re-running the pipeline after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();
    await runPipeline();

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);
    expect(existsInTelemetry("lifecycle_events")).toBe(false);
    expect(outboxLifecycleRows()).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the outbox does not fail the pipeline", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain/backfill batch's copy and delete re-copies the
    // same rows next boot; INSERT OR IGNORE must keep the already-copied row.
    getTelemetrySqlite()!.exec(
      `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload)
       VALUES ('seed-dupe', 'lifecycle', 3000, NULL, '{"type":"lifecycle","event_name":"already-copied"}')`,
    );

    await runPipeline();

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);
    const rows = outboxLifecycleRows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === "seed-dupe")!.payload.event_name).toBe(
      "already-copied",
    );
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(`CREATE TABLE main.lifecycle_events (${SOURCE_COLUMNS})`);

    await runPipeline();

    expect(existsInMain("lifecycle_events")).toBe(false);
    expect(existsInMain("lifecycle_events__relocating")).toBe(false);
    expect(outboxLifecycleRows()).toHaveLength(0);
  });
});
