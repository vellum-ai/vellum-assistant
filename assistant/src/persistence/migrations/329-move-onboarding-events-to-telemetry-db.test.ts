/**
 * Tests for migration 329: relocating `onboarding_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`), covered
 * as the head of the full pipeline — migration 334 then backfills the
 * relocated rows into the generic `telemetry_events` outbox and drops the
 * telemetry-side table.
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran the pipeline once, so each test
 * recreates the pre-move source table in `main` to simulate an upgrading
 * install, then runs 329 + 334 directly.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateMoveOnboardingEventsToTelemetryDb } =
  await import("./329-move-onboarding-events-to-telemetry-db.js");
const { migrateBackfillTelemetryEventsOutbox } =
  await import("./334-backfill-telemetry-events-outbox.js");

await initializeDb();

const SOURCE_COLUMNS = `
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, screen TEXT NOT NULL,
  tools_json TEXT, tasks_json TEXT, tone TEXT, google_connected INTEGER,
  google_scopes_json TEXT, prior_assistants_json TEXT, ab_variant TEXT,
  session_id TEXT, step_name TEXT, step_index INTEGER, completed_at TEXT,
  funnel_version TEXT`;

/** Backfilled outbox rows for the onboarding source, in `(created_at, id)` order. */
function outboxOnboardingRows(): Array<{
  id: string;
  payload: Record<string, unknown>;
}> {
  return (
    getTelemetrySqlite()!
      .query(
        `SELECT id, payload FROM telemetry_events
         WHERE name = 'onboarding' ORDER BY created_at, id`,
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
  getTelemetrySqlite()!.exec(`DROP TABLE IF EXISTS onboarding_events`);
  getTelemetrySqlite()!.exec(
    `DELETE FROM telemetry_events WHERE name = 'onboarding'`,
  );
  getTelemetrySqlite()!.exec(
    `DELETE FROM flush_checkpoints WHERE key LIKE 'telemetry:onboarding:%'`,
  );
  getSqlite().exec(`DROP TABLE IF EXISTS main.onboarding_events`);
  getSqlite().exec(`DROP TABLE IF EXISTS main."onboarding_events__relocating"`);
}

function seedSourceTable(): void {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE main.onboarding_events (${SOURCE_COLUMNS})`);
  const insert = sqlite.prepare(
    `INSERT INTO main.onboarding_events
       (id, created_at, screen, session_id, step_name, step_index, funnel_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("seed-1", 1000, "tools", "conv-1", null, null, null);
  insert.run(
    "seed-2",
    2000,
    "activation_moment_1_complete",
    "conv-2",
    "activation_moment_1_complete",
    1,
    "v2",
  );
  insert.run("seed-dupe", 3000, "tasks", "conv-3", null, null, null);
}

async function runPipeline(): Promise<void> {
  await migrateMoveOnboardingEventsToTelemetryDb(getDb());
  migrateBackfillTelemetryEventsOutbox(getDb());
}

describe("migration 329: move onboarding_events to the telemetry DB", () => {
  test("pre-move rows land in telemetry_events and both legacy tables are gone", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);
    expect(existsInTelemetry("onboarding_events")).toBe(false);

    const rows = outboxOnboardingRows();
    expect(rows.map((r) => r.id)).toEqual(["seed-1", "seed-2", "seed-dupe"]);
    expect(rows[0]!.payload).toMatchObject({
      type: "onboarding",
      daemon_event_id: "seed-1",
      recorded_at: 1000,
      screen: "tools",
      session_id: "conv-1",
    });
    // Activation rows carry the deterministic wire id; the outbox row id
    // stays the original row id.
    expect(rows[1]!.payload).toMatchObject({
      daemon_event_id: "v2:conv-2:activation_moment_1_complete",
      step_name: "activation_moment_1_complete",
      step_index: 1,
      funnel_version: "v2",
    });
  });

  test("re-running the pipeline after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();
    await runPipeline();

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);
    expect(existsInTelemetry("onboarding_events")).toBe(false);
    expect(outboxOnboardingRows()).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the outbox does not fail the pipeline", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain/backfill batch's copy and delete re-copies the
    // same rows next boot; INSERT OR IGNORE must keep the already-copied row.
    getTelemetrySqlite()!.exec(
      `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload)
       VALUES ('seed-dupe', 'onboarding', 3000, NULL, '{"type":"onboarding","screen":"already-copied"}')`,
    );

    await runPipeline();

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);
    const rows = outboxOnboardingRows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === "seed-dupe")!.payload.screen).toBe(
      "already-copied",
    );
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(`CREATE TABLE main.onboarding_events (${SOURCE_COLUMNS})`);

    await runPipeline();

    expect(existsInMain("onboarding_events")).toBe(false);
    expect(existsInMain("onboarding_events__relocating")).toBe(false);
    expect(outboxOnboardingRows()).toHaveLength(0);
  });
});
