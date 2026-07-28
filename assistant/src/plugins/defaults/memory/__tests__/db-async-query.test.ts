/**
 * Tests for `db-async-query.ts` — the runAsyncSqlite abstraction.
 *
 * The contract this PR locks in:
 *   1. **The main event loop keeps ticking while a long SQLite
 *      statement is in flight via the sqlite3 CLI backend.** This is
 *      the structural anti-block assertion — a recursive `setImmediate`
 *      probe counts event-loop iterations during the operation; if
 *      anyone moves the slow path back onto the main thread,
 *      `bun:sqlite` is synchronous and tick counting collapses to ~0;
 *      this test fails loudly.
 *   2. The CLI backend reports `backend: "sqlite3-cli"` and `ok: true`
 *      on success.
 *   3. The in-process fallback backend executes the statement
 *      synchronously and reports `backend: "in-process-blocking"`.
 *   4. Errors from sqlite3 surface as `ok: false` with the stderr
 *      preserved in `error`.
 */
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { removeTestDbFiles } from "../../../../__tests__/assert-not-live-db.js";

const { getSqlite } = await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const {
  runAsyncSqlite,
  _resetFallbackWarning,
  spawnDetachedWalCheckpoint,
  attachStatements,
  parseChangesFromStdout,
} = await import("../../../../persistence/db-async-query.js");
const { findSqlite3 } = await import("../../../../util/sqlite3-runtime.js");
const { getDbPath } = await import("../../../../util/platform.js");

await initializeDb();

const sqlite3Available = findSqlite3() !== undefined;

beforeEach(() => {
  _resetFallbackWarning();
});

function inflateAndDelete(byteTarget: number): void {
  const sqlite = getSqlite();
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS async_bloat (id INTEGER PRIMARY KEY, payload BLOB)",
  );
  const pageSize = (
    sqlite.query("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  const rowsTarget = Math.max(1, Math.ceil(byteTarget / pageSize));
  const payload = new Uint8Array(Math.max(1, pageSize - 64));
  const insert = sqlite.prepare("INSERT INTO async_bloat (payload) VALUES (?)");
  sqlite.exec("BEGIN");
  for (let i = 0; i < rowsTarget; i++) {
    insert.run(payload);
  }
  sqlite.exec("COMMIT");
  sqlite.exec("DELETE FROM async_bloat");
  sqlite.exec("DROP TABLE async_bloat");
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

describe("runAsyncSqlite", () => {
  test("returns ok=true for a trivial statement", async () => {
    const result = await runAsyncSqlite("SELECT 1", "test:trivial-select");
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  test("in-process fallback reports the right backend", async () => {
    const result = await runAsyncSqlite("SELECT 1", "test:in-process-backend", {
      forceBackend: "in-process-blocking",
    });
    expect(result.ok).toBe(true);
    expect(result.backend).toBe("in-process-blocking");
  });

  test("in-process fallback emits changes() count on stdout after a DELETE", async () => {
    // Regression for Codex P1 on #31894: callers (e.g. prune jobs) rely
    // on reading the row count off `result.stdout`. The CLI backend
    // populates this naturally when the SQL ends with `SELECT changes();`,
    // but `bun:sqlite`'s `exec()` discards SELECT results — so the
    // in-process backend has to synthesize the same line, or the
    // re-enqueue gate in pruneOld*Job silently never fires on hosts
    // without the sqlite3 CLI.
    const sqlite = getSqlite();
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS async_changes_probe (id INTEGER PRIMARY KEY)",
    );
    sqlite.exec("DELETE FROM async_changes_probe");
    sqlite.exec(
      "INSERT INTO async_changes_probe (id) VALUES (1),(2),(3),(4),(5)",
    );

    const result = await runAsyncSqlite(
      "DELETE FROM async_changes_probe WHERE id <= 3; SELECT changes();",
      "test:in-process-changes-count",
      { forceBackend: "in-process-blocking" },
    );

    expect(result.ok).toBe(true);
    expect(result.backend).toBe("in-process-blocking");
    // The synthesized stdout matches what the CLI backend would emit:
    // a bare integer on its own line. The exact format keeps the
    // parser in cleanup.ts backend-agnostic.
    expect(result.stdout).toBe("3\n");

    sqlite.exec("DROP TABLE async_changes_probe");
  });

  test.if(sqlite3Available)(
    "sqlite3 CLI backend reports the right backend on success",
    async () => {
      const result = await runAsyncSqlite(
        "SELECT 1",
        "test:cli-backend-success",
      );
      expect(result.ok).toBe(true);
      expect(result.backend).toBe("sqlite3-cli");
    },
  );

  test.if(sqlite3Available)(
    "surfaces sqlite3 errors as ok=false with the message preserved",
    async () => {
      // Intentional SQL syntax error.
      const result = await runAsyncSqlite(
        "THIS IS NOT VALID SQL",
        "test:cli-error",
      );
      expect(result.ok).toBe(false);
      expect(result.backend).toBe("sqlite3-cli");
      expect(result.error).toBeTruthy();
    },
  );

  test.if(sqlite3Available)(
    "VACUUM via sqlite3 CLI keeps the event loop ticking (anti-block)",
    async () => {
      // Inflate the DB so VACUUM has measurable work to do. Without
      // this the subprocess finishes in single-digit ms and the
      // probe has no opportunity to record meaningful ticks.
      inflateAndDelete(8 * 1024 * 1024);

      // Probe the event loop with recursive setImmediate. This fires
      // on every event-loop iteration with no minimum delay, so on a
      // healthy unblocked loop it produces tens of thousands of ticks
      // per second (vs. setInterval(1) which is capped by the host's
      // timer resolution — observed at ~32 ms on GitHub Actions
      // runners). If anyone moves VACUUM back onto the main thread,
      // `bun:sqlite` is sync and tick count collapses to ~0; the
      // assertion below fails loudly. The signal is intentionally
      // binary: "many" vs "none".
      let tickCount = 0;
      let probing = true;
      const tick = (): void => {
        if (!probing) return;
        tickCount += 1;
        setImmediate(tick);
      };
      setImmediate(tick);

      let result;
      try {
        result = await runAsyncSqlite("VACUUM", "test:vacuum-anti-block");
      } finally {
        probing = false;
      }

      expect(result.ok).toBe(true);
      expect(result.backend).toBe("sqlite3-cli");

      // Any positive tick count proves the event loop wasn't blocked.
      // A sync in-process VACUUM would collapse this to 0.
      expect(tickCount).toBeGreaterThanOrEqual(1);
    },
    60_000,
  );
});

function tempDbPath(tag: string): string {
  return join(tmpdir(), `async-attach-${tag}-${process.pid}-${Date.now()}.db`);
}

describe("runAsyncSqlite attach mode", () => {
  test("attachStatements attaches the alias and sets it to synchronous=NORMAL", () => {
    // Both backends build their ATTACH SQL from this one helper, so a unit
    // test here covers the per-alias pragma on both the CLI and in-process
    // paths.
    expect(
      attachStatements({ path: "/tmp/target.db", alias: "_reloc_target" }),
    ).toEqual([
      "ATTACH DATABASE '/tmp/target.db' AS _reloc_target",
      "PRAGMA _reloc_target.synchronous=NORMAL",
    ]);
  });

  test("attachStatements escapes single quotes in the attached path", () => {
    expect(attachStatements({ path: "/tmp/o'brien.db", alias: "t" })).toEqual([
      "ATTACH DATABASE '/tmp/o''brien.db' AS t",
      "PRAGMA t.synchronous=NORMAL",
    ]);
  });

  test.if(sqlite3Available)(
    "the attached schema runs at synchronous=NORMAL (CLI backend)",
    async () => {
      const targetPath = tempDbPath("cli");
      // Materialize a real WAL database so ATTACH opens it the way a relocation
      // target file is opened in production.
      const seed = new Database(targetPath);
      seed.exec("PRAGMA journal_mode=WAL");
      seed.exec("CREATE TABLE probe (x)");
      seed.close();
      try {
        const result = await runAsyncSqlite(
          "PRAGMA _reloc_target.synchronous;",
          "test:attach-synchronous-cli",
          { attach: [{ path: targetPath, alias: "_reloc_target" }] },
        );
        expect(result.ok).toBe(true);
        expect(result.backend).toBe("sqlite3-cli");
        // PRAGMA synchronous prints its numeric level as the trailing line:
        // NORMAL === 1. Without the per-alias pragma the attached schema would
        // report FULL === 2 (the default), fsyncing every cross-DB commit.
        expect(parseChangesFromStdout(result.stdout)).toBe(1);
      } finally {
        removeTestDbFiles(targetPath);
      }
    },
  );

  test("in-process fallback runs the ATTACH prelude and writes across databases", async () => {
    const targetPath = tempDbPath("inproc");
    const seed = new Database(targetPath);
    seed.exec("CREATE TABLE attach_probe (id INTEGER PRIMARY KEY)");
    seed.close();
    try {
      // `attach_probe` exists only in the attached target, so the unqualified
      // write resolves there — exercising the in-process ATTACH branch that
      // brings the attached schema to synchronous=NORMAL alongside `main`.
      const result = await runAsyncSqlite(
        "INSERT INTO attach_probe (id) VALUES (1); SELECT changes();",
        "test:attach-synchronous-in-process",
        {
          forceBackend: "in-process-blocking",
          attach: [{ path: targetPath, alias: "_reloc_target" }],
        },
      );
      expect(result.ok).toBe(true);
      expect(result.backend).toBe("in-process-blocking");
      expect(result.stdout).toBe("1\n");

      // The row is durable in the attached file.
      const verify = new Database(targetPath);
      const count = (
        verify.query("SELECT count(*) AS c FROM attach_probe").get() as {
          c: number;
        }
      ).c;
      verify.close();
      expect(count).toBe(1);
    } finally {
      removeTestDbFiles(targetPath);
    }
  });
});

describe("spawnDetachedWalCheckpoint", () => {
  test.if(sqlite3Available)(
    "folds and truncates the WAL from a detached subprocess",
    async () => {
      const sqlite = getSqlite();
      const walPath = `${getDbPath()}-wal`;

      // Grow the WAL past zero without checkpointing.
      sqlite.exec("CREATE TABLE IF NOT EXISTS detached_ckpt_probe (x TEXT)");
      sqlite.exec("INSERT INTO detached_ckpt_probe VALUES ('row')");
      expect(statSync(walPath).size).toBeGreaterThan(0);

      expect(spawnDetachedWalCheckpoint()).toBe(true);

      // The child is detached with no inherited stdio, so the only
      // observable effect is the WAL file itself — poll for the truncate.
      const deadline = Date.now() + 10_000;
      let walSize = -1;
      while (Date.now() < deadline) {
        walSize = statSync(walPath).size;
        if (walSize === 0) {
          break;
        }
        await Bun.sleep(50);
      }
      expect(walSize).toBe(0);

      sqlite.exec("DROP TABLE detached_ckpt_probe");
    },
    30_000,
  );
});
