/**
 * Tests for migration 330: relocating `skill_loaded_events` from the main DB
 * into the dedicated telemetry database (`assistant-telemetry.db`).
 *
 * Runs against real workspace databases (`initializeDb()`) because the drain
 * engine dispatches batches via `runAsyncSqlite` against the workspace's main
 * DB file. `initializeDb()` already ran migration 330 once (dropping the empty
 * main-side table created by migration 279), so each test recreates the
 * pre-move source table in `main` to simulate an upgrading install.
 */
import { describe, expect, test } from "bun:test";

const { getDb, getSqlite, getTelemetrySqlite } =
  await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { queryUnreportedSkillLoadedEvents } =
  await import("../../telemetry/skill-loaded-events-store.js");
const { migrateMoveSkillLoadedEventsToTelemetryDb } =
  await import("./330-move-skill-loaded-events-to-telemetry-db.js");
const { rawTelemetryRun } = await import("../raw-query.js");

await initializeDb();

const SOURCE_COLUMNS = `
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, conversation_id TEXT,
  skill_name TEXT NOT NULL, skill_updated_at TEXT, provider TEXT, model TEXT,
  inference_profile TEXT, inference_profile_source TEXT`;

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
  getTelemetrySqlite()!.exec(`DELETE FROM skill_loaded_events`);
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

describe("migration 330: move skill_loaded_events to the telemetry DB", () => {
  test("drains pre-move rows into the telemetry DB and drops the main-side table", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveSkillLoadedEventsToTelemetryDb(getDb());

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);

    const moved = getTelemetrySqlite()!
      .query(
        `SELECT id, skill_name, conversation_id FROM skill_loaded_events ORDER BY id`,
      )
      .all();
    expect(moved).toEqual([
      { id: "seed-1", skill_name: "web-research", conversation_id: "conv-a" },
      { id: "seed-2", skill_name: "tasks", conversation_id: null },
      { id: "seed-dupe", skill_name: "calendar", conversation_id: "conv-b" },
    ]);

    // The relocated rows are readable through the store's reporter query.
    const rows = queryUnreportedSkillLoadedEvents(0, undefined, 10);
    expect(rows.map((r) => r.id)).toEqual(["seed-1", "seed-2", "seed-dupe"]);
    expect(rows[0]).toEqual({
      id: "seed-1",
      createdAt: 1000,
      conversationId: "conv-a",
      skillName: "web-research",
      skillUpdatedAt: null,
      provider: null,
      model: null,
      inferenceProfile: null,
      inferenceProfileSource: null,
    });
  });

  test("re-running after a completed move is a no-op", async () => {
    resetState();
    seedSourceTable();

    await migrateMoveSkillLoadedEventsToTelemetryDb(getDb());
    await migrateMoveSkillLoadedEventsToTelemetryDb(getDb());

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);
    expect(queryUnreportedSkillLoadedEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("a pre-existing duplicate id in the telemetry copy does not fail the drain", async () => {
    resetState();
    seedSourceTable();

    // A crash between a drain batch's copy and delete re-copies the same rows
    // next boot; INSERT OR IGNORE must keep the already-copied row and finish.
    getTelemetrySqlite()!.exec(
      `INSERT INTO skill_loaded_events (id, created_at, skill_name)
       VALUES ('seed-dupe', 3000, 'already-copied')`,
    );

    await migrateMoveSkillLoadedEventsToTelemetryDb(getDb());

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);
    const dupe = getTelemetrySqlite()!
      .query(
        `SELECT skill_name FROM skill_loaded_events WHERE id = 'seed-dupe'`,
      )
      .get() as { skill_name: string };
    expect(dupe.skill_name).toBe("already-copied");
    expect(queryUnreportedSkillLoadedEvents(0, undefined, 10)).toHaveLength(3);
  });

  test("an empty main-side table (fresh install) is dropped without a drain", async () => {
    resetState();
    getSqlite().exec(
      `CREATE TABLE main.skill_loaded_events (${SOURCE_COLUMNS})`,
    );

    await migrateMoveSkillLoadedEventsToTelemetryDb(getDb());

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);
    expect(queryUnreportedSkillLoadedEvents(0, undefined, 10)).toHaveLength(0);
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

    await migrateMoveSkillLoadedEventsToTelemetryDb(getDb());

    expect(existsInMain("skill_loaded_events")).toBe(false);
    expect(existsInMain("skill_loaded_events__relocating")).toBe(false);

    const moved = queryUnreportedSkillLoadedEvents(0, undefined, 10);
    expect(moved.map((r) => r.id)).toEqual(["live-1", "null-1"]);
    const dead = getTelemetrySqlite()!
      .query(`SELECT 1 FROM skill_loaded_events WHERE id = 'dead-1'`)
      .get();
    expect(dead).toBeNull();
  });

  test("per-conversation redaction deletes rows on the telemetry connection", () => {
    resetState();
    getTelemetrySqlite()!.exec(
      `INSERT INTO skill_loaded_events (id, created_at, conversation_id, skill_name)
       VALUES ('red-1', 1000, 'conv-pruned', 'web-research'),
              ('red-2', 2000, 'conv-kept', 'tasks')`,
    );

    // The exact delete the conversation prune runs (job-handlers/cleanup.ts).
    rawTelemetryRun(
      "test:prune-redaction",
      `DELETE FROM skill_loaded_events WHERE conversation_id = ?`,
      "conv-pruned",
    );

    const remaining = queryUnreportedSkillLoadedEvents(0, undefined, 10);
    expect(remaining.map((r) => r.id)).toEqual(["red-2"]);
  });

  test("telemetry-side schema has the reporter's compound cursor index", () => {
    const indexes = (
      getTelemetrySqlite()!
        .query(`PRAGMA index_list(skill_loaded_events)`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_skill_loaded_events_created_at_id");
  });
});
