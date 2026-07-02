/**
 * Tests for the dedicated logs database connection.
 *
 * What this locks in:
 *   1. Opening the logs connection creates `assistant-logs.db` on disk and
 *      runs it in WAL mode (its own `-wal`, independent of the main DB) — the
 *      regression that lets a heavy append-only table bloat the *main* WAL is
 *      exactly what this split exists to prevent.
 *   2. The main connection no longer ATTACHes the logs file: there is no
 *      `logs` schema on its `database_list`.
 *   3. `llm_request_logs` lives in the dedicated logs connection, not in the
 *      main connection — proving the physical split.
 *   4. `runAsyncSqlite({ dbPath })` targets the given file via the sqlite3
 *      CLI backend, leaving the main DB untouched.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { removeTestDbFiles } from "../../../../__tests__/assert-not-live-db.js";

const { getSqlite, getLogsSqlite } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { runAsyncSqlite } =
  await import("../../../../persistence/db-async-query.js");
const { getLogsDbPath } = await import("../../../../util/logs-db-path.js");
const { findSqlite3 } = await import("../../../../util/sqlite3-runtime.js");

await initializeDb();

const sqlite3Available = findSqlite3() !== undefined;

describe("logs database connection", () => {
  test("opens the logs file and creates it on disk in WAL mode", () => {
    const logs = getLogsSqlite();
    expect(logs).not.toBeNull();
    expect(existsSync(getLogsDbPath())).toBe(true);

    const mode = logs!
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    expect(mode?.journal_mode).toBe("wal");
  });

  test("the main connection does not attach the logs file", () => {
    const attached = getSqlite()
      .query<{ name: string }, []>("PRAGMA database_list")
      .all();
    expect(attached.some((e) => e.name === "logs")).toBe(false);
  });

  test("llm_request_logs lives in the logs connection, not main", () => {
    const inLogs = getLogsSqlite()!
      .query<
        { name: string },
        []
      >(`SELECT name FROM sqlite_master WHERE type='table' AND name='llm_request_logs'`)
      .get();
    expect(inLogs?.name).toBe("llm_request_logs");

    const inMain = getSqlite()
      .query<
        { name: string },
        []
      >(`SELECT name FROM main.sqlite_master WHERE name='llm_request_logs'`)
      .get();
    expect(inMain).toBeNull();
  });

  test.if(sqlite3Available)(
    "runAsyncSqlite({ dbPath }) targets the given file, not the main DB",
    async () => {
      const targetPath = join(tmpdir(), `vellum-async-dbpath-${Date.now()}.db`);
      try {
        const result = await runAsyncSqlite(
          "CREATE TABLE dbpath_probe (x INTEGER); INSERT INTO dbpath_probe VALUES (42); SELECT changes();",
          "test:logs-attach-dbpath",
          { dbPath: targetPath, forceBackend: "sqlite3-cli" },
        );
        expect(result.ok).toBe(true);
        expect(result.backend).toBe("sqlite3-cli");

        // The target file got the table…
        const { Database } = await import("bun:sqlite");
        const probe = new Database(targetPath, { readonly: true });
        try {
          const row = probe
            .query<
              { name: string },
              []
            >("SELECT name FROM sqlite_master WHERE name = 'dbpath_probe'")
            .get();
          expect(row?.name).toBe("dbpath_probe");
        } finally {
          probe.close();
        }

        // …and the main DB did not.
        const inMain = getSqlite()
          .query<
            { name: string },
            []
          >("SELECT name FROM main.sqlite_master WHERE name = 'dbpath_probe'")
          .get();
        expect(inMain).toBeNull();
      } finally {
        removeTestDbFiles(targetPath);
      }
    },
  );
});
