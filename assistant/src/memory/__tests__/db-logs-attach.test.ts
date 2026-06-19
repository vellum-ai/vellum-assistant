/**
 * Tests for the secondary append-only database file wiring (PR 1).
 *
 * What this locks in:
 *   1. Opening the connection ATTACHes `assistant-logs.db` as the `logs`
 *      schema and creates the file on disk.
 *   2. The attached schema runs in WAL mode (its own `-wal`, independent of
 *      the main DB) — the regression that lets a heavy append-only table
 *      bloat the *main* WAL is exactly what this split exists to prevent.
 *   3. A table created in the `logs` schema lives in the separate file, not
 *      in `main` — proving the physical split rather than just an alias.
 *   4. `runAsyncSqlite({ dbPath })` targets the given file via the sqlite3
 *      CLI backend, leaving the main DB untouched.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { removeTestDbFiles } from "../../__tests__/assert-not-live-db.js";

const { getSqlite, LOGS_DB_SCHEMA } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { runAsyncSqlite } = await import("../db-async-query.js");
const { getLogsDbPath } = await import("../../util/logs-db-path.js");
const { findSqlite3 } = await import("../../util/sqlite3-runtime.js");

initializeDb();

const sqlite3Available = findSqlite3() !== undefined;

describe("logs database attachment", () => {
  test("ATTACHes the logs file as the logs schema and creates it on disk", () => {
    // Touch the connection so the attach runs.
    getSqlite();
    expect(existsSync(getLogsDbPath())).toBe(true);

    const attached = getSqlite()
      .query<{ name: string; file: string }, []>("PRAGMA database_list")
      .all();
    const logsEntry = attached.find((e) => e.name === LOGS_DB_SCHEMA);
    expect(logsEntry).toBeDefined();
    expect(logsEntry?.file).toBe(getLogsDbPath());
  });

  test("the attached schema runs in WAL mode", () => {
    const mode = getSqlite()
      .query<
        { journal_mode: string },
        []
      >(`PRAGMA ${LOGS_DB_SCHEMA}.journal_mode`)
      .get();
    expect(mode?.journal_mode).toBe("wal");
  });

  test("a table created in the logs schema lives in the logs file, not main", () => {
    const sqlite = getSqlite();
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS ${LOGS_DB_SCHEMA}.attach_probe (id INTEGER PRIMARY KEY)`,
    );
    try {
      const inLogs = sqlite
        .query<
          { name: string },
          []
        >(`SELECT name FROM ${LOGS_DB_SCHEMA}.sqlite_master WHERE name = 'attach_probe'`)
        .get();
      expect(inLogs?.name).toBe("attach_probe");

      const inMain = sqlite
        .query<
          { name: string },
          []
        >(`SELECT name FROM main.sqlite_master WHERE name = 'attach_probe'`)
        .get();
      expect(inMain).toBeNull();
    } finally {
      sqlite.exec(`DROP TABLE ${LOGS_DB_SCHEMA}.attach_probe`);
    }
  });

  test.if(sqlite3Available)(
    "runAsyncSqlite({ dbPath }) targets the given file, not the main DB",
    async () => {
      const targetPath = join(tmpdir(), `vellum-async-dbpath-${Date.now()}.db`);
      try {
        const result = await runAsyncSqlite(
          "CREATE TABLE dbpath_probe (x INTEGER); INSERT INTO dbpath_probe VALUES (42); SELECT changes();",
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
