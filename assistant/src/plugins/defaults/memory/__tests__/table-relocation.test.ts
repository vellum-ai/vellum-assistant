/**
 * Tests for the incremental table-relocation engine
 * (`migrations/helpers/relocation.ts`), driven with migration 298's
 * `MEMORY_JOBS_RELOCATION` spec.
 *
 * What this locks in:
 *   1. `stageTableForRelocation` drops an empty source, renames a populated
 *      one aside to `<table>__relocating`, and is idempotent across re-runs.
 *   2. `drainStagedTable` copies the rows worth keeping into the target file,
 *      purges the rest without copying, applies the spec's per-column
 *      transforms (`running` → `pending`), and drops the staging table — so a
 *      heavy table moves in bounded awaited batches rather than one blocking
 *      shot.
 *
 * The drain runs through `runAsyncSqlite`, which targets the memory file
 * directly (sqlite3 subprocess where available; in-process transient
 * connection otherwise) — independent of the daemon connection, which no longer
 * ATTACHes the dedicated files.
 */
import { describe, expect, test } from "bun:test";

const { getSqlite, getMemorySqlite } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { drainStagedTable, stageTableForRelocation } =
  await import("../../../../persistence/migrations/helpers/relocation.js");
const { MEMORY_JOBS_RELOCATION } =
  await import("../../../../persistence/migrations/298-move-memory-jobs-to-memory-db.js");

await initializeDb();

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
    const memory = getMemorySqlite()!;

    // Clean slate: empty live queue, fresh populated staging table.
    memory.exec(`DELETE FROM memory_jobs`);
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

    await drainStagedTable(sqlite, MEMORY_JOBS_RELOCATION);

    // Staging dropped.
    expect(existsInMain("memory_jobs__relocating")).toBe(false);

    // Exactly the three keepers landed in the memory database; the terminal
    // rows were purged without being copied, and the in-flight `running` row
    // was reset to `pending` so the worker can re-claim it in its new home.
    const kept = memory
      .query<
        { id: string; status: string },
        []
      >(`SELECT id, status FROM memory_jobs WHERE id LIKE 'seed-%' ORDER BY id`)
      .all();
    expect(kept).toEqual([
      { id: "seed-keep-1", status: "pending" },
      { id: "seed-keep-2", status: "pending" },
      { id: "seed-keep-3", status: "pending" },
    ]);
  });
});
