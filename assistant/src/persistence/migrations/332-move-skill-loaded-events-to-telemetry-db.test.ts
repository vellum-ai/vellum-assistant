/**
 * Tests for migration 332: relocating `skill_loaded_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`), covered
 * as the head of the full pipeline — migration 334 then backfills the
 * relocated rows into the generic `telemetry_events` outbox (with the
 * conversation id in its dedicated column) and drops the telemetry-side
 * table.
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran the pipeline once, so each test
 * recreates the pre-move source table in `main` to simulate an upgrading
 * install, then runs 332 + 334 directly.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateMoveSkillLoadedEventsToTelemetryDb } =
  await import("./332-move-skill-loaded-events-to-telemetry-db.js");
const { migrateBackfillTelemetryEventsOutbox } =
  await import("./334-backfill-telemetry-events-outbox.js");

await initializeDb();

const SOURCE_COLUMNS = `
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, conversation_id TEXT,
  skill_name TEXT NOT NULL, skill_updated_at TEXT, provider TEXT, model TEXT,
  inference_profile TEXT, inference_profile_source TEXT`;

/** Backfilled outbox rows for the skill_loaded source, in `(created_at, id)` order. */
function outboxSkillRows(): Array<{
  id: string;
  conversation_id: string | null;
  payload: Record<string, unknown>;
}> {
  return (
    getTelemetrySqlite()!
      .query(
        `SELECT id, conversation_id, payload FROM telemetry_events
         WHERE name = 'skill_loaded' ORDER BY created_at, id`,
      )
      .all() as Array<{
      id: string;
      conversation_id: string | null;
      payload: string;
    }>
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
  getTelemetrySqlite()!.exec(`DROP TABLE IF EXISTS skill_loaded_events`);
  getTelemetrySqlite()!.exec(
    `DELETE FROM telemetry_events WHERE name = 'skill_loaded'`,
  );
  getTelemetrySqlite()!.exec(
    `DELETE FROM flush_checkpoints WHERE key LIKE 'telemetry:skill_loaded:%'`,
  );
  getSqlite().exec(`DROP TABLE IF EXISTS main.skill_loaded_events`);
  getSqlite().exec(
    `DROP TABLE IF EXISTS main."skill_loaded_events__relocating"`,
  );
  getSqlite().exec(
    `DELETE FROM conversations WHERE id IN ('conv-a', 'conv-b', 'conv-live')`,
  );
}

/** The drain only copies rows whose conversation is live (or NULL). */
function seedConversation(id: string): void {
  getSqlite()
    .prepare(
      `INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, 0, 0)`,
    )
    .run(id);
}

function seedSourceTable(): void {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE main.skill_loaded_events (${SOURCE_COLUMNS})`);
  seedConversation("conv-a");
  seedConversation("conv-b");
  const insert = sqlite.prepare(
    `INSERT INTO main.skill_loaded_events (id, created_at, conversation_id, skill_name)
     VALUES (?, ?, ?, ?)`,
  );
  insert.run("seed-1", 1000, "conv-a", "web-research");
  insert.run("seed-2", 2000, null, "tasks");
  insert.run("seed-dupe", 3000, "conv-b", "calendar");
}

async function runPipeline(): Promise<void> {
  await migrateMoveSkillLoadedEventsToTelemetryDb(getDb());
  migrateBackfillTelemetryEventsOutbox(getDb());
}

describe("migration 332: move skill_loaded_events to the telemetry DB", () => {
  test("pre-move rows land in telemetry_events with the conversation id column; both legacy tables are gone", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);
    expect(existsInTelemetry("skill_loaded_events")).toBe(false);

    const rows = outboxSkillRows();
    expect(rows.map((r) => r.id)).toEqual(["seed-1", "seed-2", "seed-dupe"]);
    expect(rows.map((r) => r.conversation_id)).toEqual([
      "conv-a",
      null,
      "conv-b",
    ]);
    // Every column reaches the wire payload intact.
    expect(rows[0]!.payload).toMatchObject({
      type: "skill_loaded",
      daemon_event_id: "seed-1",
      recorded_at: 1000,
      skill_name: "web-research",
      skill_updated_at: null,
      conversation_id: "conv-a",
      provider: null,
      model: null,
      inference_profile: null,
      inference_profile_source: null,
    });
  });

  test("re-running the pipeline after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await runPipeline();
    await runPipeline();

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);
    expect(existsInTelemetry("skill_loaded_events")).toBe(false);
    expect(outboxSkillRows()).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the outbox does not fail the pipeline", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain/backfill batch's copy and delete re-copies the
    // same rows next boot; INSERT OR IGNORE must keep the already-copied row.
    getTelemetrySqlite()!.exec(
      `INSERT INTO telemetry_events (id, name, created_at, conversation_id, payload)
       VALUES ('seed-dupe', 'skill_loaded', 3000, 'conv-b', '{"type":"skill_loaded","skill_name":"already-copied"}')`,
    );

    await runPipeline();

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);
    const rows = outboxSkillRows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === "seed-dupe")!.payload.skill_name).toBe(
      "already-copied",
    );
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(
      `CREATE TABLE main.skill_loaded_events (${SOURCE_COLUMNS})`,
    );

    await runPipeline();

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);
    expect(outboxSkillRows()).toHaveLength(0);
  });

  test("the drain purges rows whose conversation no longer exists (redaction across boots)", async () => {
    resetState();
    const sqlite = getSqlite();
    sqlite.exec(`CREATE TABLE main.skill_loaded_events (${SOURCE_COLUMNS})`);
    seedConversation("conv-live");
    const insert = sqlite.prepare(
      `INSERT INTO main.skill_loaded_events (id, created_at, conversation_id, skill_name)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("live-1", 1000, "conv-live", "web-research");
    insert.run("null-1", 2000, null, "tasks");
    // Simulates a conversation deleted while its rows sat staged between boots:
    // the redaction paths only delete on the telemetry connection, so the drain
    // itself must purge this row rather than resurrect it.
    insert.run("dead-1", 3000, "conv-deleted", "calendar");

    await runPipeline();

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);

    expect(outboxSkillRows().map((r) => r.id)).toEqual(["live-1", "null-1"]);
  });
});
