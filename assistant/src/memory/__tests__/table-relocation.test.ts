/**
 * Tests for the incremental table-relocation engine (`relocation.ts`).
 *
 * What this locks in:
 *   1. `stageTableForRelocation` drops an empty source, renames a populated
 *      one aside to `<table>__relocating`, and is idempotent across re-runs.
 *   2. `drainStagedTable` copies the rows worth keeping into the attached
 *      target, purges the rest without copying, and drops the staging table —
 *      so a heavy table moves in bounded awaited batches rather than one
 *      blocking shot.
 *
 * sqlite3 may not be on the host here, so the drain runs through the in-process
 * `runAsyncSqlite` fallback — which exercises the same cross-database SQL on the
 * daemon connection (it already has the `memory`/`logs` databases attached).
 */
import { describe, expect, test } from "bun:test";

const { getSqlite, MEMORY_DB_SCHEMA } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { drainStagedTable, stageTableForRelocation } =
  await import("../relocation.js");

initializeDb();

function existsInMain(name: string): boolean {
  return (
    getSqlite()
      .query(
        `SELECT name FROM main.sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(name) != null
  );
}

const MEMORY_JOBS_COLUMNS = `
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  deferrals INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL,
  last_error TEXT, started_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`;

describe("stageTableForRelocation", () => {
  test("drops an empty source and reports no drain needed", () => {
    const sqlite = getSqlite();
    sqlite.exec(`DROP TABLE IF EXISTS main.reloc_probe`);
    sqlite.exec(`DROP TABLE IF EXISTS main."reloc_probe__relocating"`);
    sqlite.exec(`CREATE TABLE main.reloc_probe (id INTEGER PRIMARY KEY)`);

    expect(stageTableForRelocation(sqlite, "reloc_probe")).toBe(false);
    expect(existsInMain("reloc_probe")).toBe(false);
    expect(existsInMain("reloc_probe__relocating")).toBe(false);
  });

  test("renames a populated source aside, idempotently", () => {
    const sqlite = getSqlite();
    sqlite.exec(`DROP TABLE IF EXISTS main.reloc_probe`);
    sqlite.exec(`DROP TABLE IF EXISTS main."reloc_probe__relocating"`);
    sqlite.exec(`CREATE TABLE main.reloc_probe (id INTEGER PRIMARY KEY)`);
    sqlite.exec(`INSERT INTO main.reloc_probe VALUES (1)`);

    expect(stageTableForRelocation(sqlite, "reloc_probe")).toBe(true);
    expect(existsInMain("reloc_probe")).toBe(false);
    expect(existsInMain("reloc_probe__relocating")).toBe(true);

    // Re-running with the staging table already present is a safe no-op.
    expect(stageTableForRelocation(sqlite, "reloc_probe")).toBe(true);
    const row = sqlite
      .query<
        { id: number },
        []
      >(`SELECT id FROM main."reloc_probe__relocating"`)
      .get();
    expect(row?.id).toBe(1);

    sqlite.exec(`DROP TABLE IF EXISTS main."reloc_probe__relocating"`);
  });
});

describe("memory_jobs drain", () => {
  test("copies pending/running rows, purges terminal rows, drops staging", async () => {
    const sqlite = getSqlite();

    // Clean slate: empty live queue, fresh populated staging table.
    sqlite.exec(`DELETE FROM memory_jobs`);
    sqlite.exec(`DROP TABLE IF EXISTS main."memory_jobs__relocating"`);
    sqlite.exec(
      `CREATE TABLE main."memory_jobs__relocating" (${MEMORY_JOBS_COLUMNS})`,
    );

    const insert = sqlite.prepare(
      `INSERT INTO main."memory_jobs__relocating"
         (id, type, payload, status, run_after, created_at, updated_at)
       VALUES (?, 'embed_segment', '{}', ?, 0, 0, 0)`,
    );
    insert.run("seed-keep-1", "pending");
    insert.run("seed-keep-2", "pending");
    insert.run("seed-keep-3", "running");
    insert.run("seed-term-1", "completed");
    insert.run("seed-term-2", "completed");
    insert.run("seed-term-3", "failed");

    await drainStagedTable("memory_jobs");

    // Staging dropped.
    expect(existsInMain("memory_jobs__relocating")).toBe(false);

    // Exactly the three keepers landed in the memory database; the terminal
    // rows were purged without being copied.
    const kept = sqlite
      .query<
        { id: string; status: string },
        []
      >(`SELECT id, status FROM memory_jobs WHERE id LIKE 'seed-%' ORDER BY id`)
      .all();
    expect(kept).toEqual([
      { id: "seed-keep-1", status: "pending" },
      { id: "seed-keep-2", status: "pending" },
      { id: "seed-keep-3", status: "running" },
    ]);

    // The keepers physically live in the memory database.
    const inMemory = getSqlite()
      .query<
        { c: number },
        []
      >(`SELECT COUNT(*) AS c FROM ${MEMORY_DB_SCHEMA}.memory_jobs WHERE id LIKE 'seed-%'`)
      .get();
    expect(inMemory?.c).toBe(3);
  });
});
