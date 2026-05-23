/**
 * Tests for `db-maintenance.ts` (orchestration) and the underlying
 * `db-async-query.ts` abstraction.
 *
 * The contract this PR locks in:
 *   1. `runDbMaintenance` runs `VACUUM` through the async abstraction
 *      — when the `sqlite3` CLI is available, that means a subprocess
 *      and the daemon's main event loop keeps ticking. (The structural
 *      anti-block assertion lives in
 *      `db-async-query.test.ts`; here we focus on orchestration.)
 *   2. The subprocess actually shrinks the on-disk page count when
 *      there's reclaimable space.
 *   3. `maybeRunDbMaintenance` is genuinely async — callers can `await`
 *      it and observe completion.
 *   4. The 24 h interval guard short-circuits a recent re-run.
 *
 * The per-file temp workspace is set up by `test-preload.ts`; tests just
 * dynamic-import the DB modules so they resolve paths under that temp dir.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

const { getSqlite } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { deleteMemoryCheckpoint, getMemoryCheckpoint } =
  await import("../checkpoints.js");
const { maybeRunDbMaintenance } = await import("../db-maintenance.js");
const { getDbPath } = await import("../../util/platform.js");

initializeDb();

const MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";

beforeEach(() => {
  deleteMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY);
});

/** Inflate the test DB with bloat that VACUUM can reclaim. */
function inflateAndDelete(byteTarget: number): void {
  const sqlite = getSqlite();
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS bloat (id INTEGER PRIMARY KEY, payload BLOB)",
  );
  const pageSize = (
    sqlite.query("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  const rowsTarget = Math.max(1, Math.ceil(byteTarget / pageSize));
  const payload = new Uint8Array(Math.max(1, pageSize - 64));
  const insert = sqlite.prepare("INSERT INTO bloat (payload) VALUES (?)");
  sqlite.exec("BEGIN");
  for (let i = 0; i < rowsTarget; i++) {
    insert.run(payload);
  }
  sqlite.exec("COMMIT");
  sqlite.exec("DELETE FROM bloat");
  sqlite.exec("DROP TABLE bloat");
  // Force the WAL onto the main DB file so the bloat is visible on disk.
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

describe("maybeRunDbMaintenance", () => {
  test("returns a Promise that resolves", async () => {
    const result = maybeRunDbMaintenance();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  test("respects the 24h interval and skips when last run was recent", async () => {
    const now = Date.now();
    const recent = now - 60_000;
    const { setMemoryCheckpoint } = await import("../checkpoints.js");
    setMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY, String(recent));

    await maybeRunDbMaintenance(now);

    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(
      String(recent),
    );
  });

  test("stamps the checkpoint after a maintenance run", async () => {
    const now = Date.now();
    await maybeRunDbMaintenance(now);

    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("VACUUM reclaims pages on a bloated DB", async () => {
    const sqlite = getSqlite();
    sqlite.exec("DROP TABLE IF EXISTS bloat");
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    inflateAndDelete(8 * 1024 * 1024);

    const dbPath = getDbPath();
    // Read page_count from a fresh connection so we observe post-write
    // ground truth without snapshot caching on the main test connection.
    const readPageCount = (): number => {
      const probe = new Database(dbPath, { readonly: true });
      try {
        return (
          probe.query("PRAGMA page_count").get() as { page_count: number }
        ).page_count;
      } finally {
        probe.close();
      }
    };
    const pagesBefore = readPageCount();

    await maybeRunDbMaintenance();

    const pagesAfter = readPageCount();
    expect(pagesAfter).toBeLessThan(pagesBefore);
  }, 60_000);
});
