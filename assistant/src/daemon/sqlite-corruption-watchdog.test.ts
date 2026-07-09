/**
 * Tests for the SQLite corruption watchdog.
 *
 * The watchdog turns a `SQLITE_CORRUPT` / `SQLITE_NOTADB` error thrown by any
 * statement into a direct `sqlite_corrupted` telemetry emit (bypassing the
 * SQLite watchdog buffer). It must ignore non-corruption errors, debounce per
 * database, and — wired straight into the slow-query wrapper — fire the moment
 * a wrapped connection hits corruption. The direct emit itself (opt-out gate,
 * POST payload) is covered in `../telemetry/watchdog-direct-emit.test.ts`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Capture direct emits instead of POSTing them.
const emitCalls: Array<{ checkName: string; detail: Record<string, unknown> }> =
  [];
mock.module("../telemetry/watchdog-direct-emit.js", () => ({
  emitWatchdogEventDirect: (
    checkName: string,
    detail: Record<string, unknown>,
  ) => {
    emitCalls.push({ checkName, detail });
    return Promise.resolve();
  },
}));

import { wrapSqliteForSlowQueryLogging } from "../persistence/slow-query-log.js";
import {
  flushCorruptionEmitsForTesting,
  isSqliteCorruptionError,
  observeSqliteStatementError,
  resetSqliteCorruptionWatchdogForTesting,
  SQLITE_CORRUPTED_CHECK_NAME,
} from "./sqlite-corruption-watchdog.js";

/** A synthetic `bun:sqlite`-style error carrying a `code`. */
function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("isSqliteCorruptionError", () => {
  test("matches the SQLITE_CORRUPT / SQLITE_NOTADB families by code", () => {
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_CORRUPT", "database disk image is malformed"),
      ),
    ).toBe(true);
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_CORRUPT_VTAB", "corrupt virtual table"),
      ),
    ).toBe(true);
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_NOTADB", "file is not a database"),
      ),
    ).toBe(true);
  });

  test("matches the canonical corruption messages even without a code", () => {
    expect(
      isSqliteCorruptionError(new Error("database disk image is malformed")),
    ).toBe(true);
    expect(isSqliteCorruptionError(new Error("file is not a database"))).toBe(
      true,
    );
  });

  test("does not match transient contention or unrelated errors", () => {
    expect(
      isSqliteCorruptionError(sqliteError("SQLITE_BUSY", "database is locked")),
    ).toBe(false);
    expect(
      isSqliteCorruptionError(sqliteError("SQLITE_IOERR", "disk I/O error")),
    ).toBe(false);
    expect(
      isSqliteCorruptionError(
        sqliteError("SQLITE_CONSTRAINT", "UNIQUE constraint failed"),
      ),
    ).toBe(false);
    expect(isSqliteCorruptionError(new Error("no such table: foo"))).toBe(
      false,
    );
  });
});

describe("observeSqliteStatementError", () => {
  beforeEach(() => {
    emitCalls.length = 0;
    resetSqliteCorruptionWatchdogForTesting();
  });

  test("a corruption error emits sqlite_corrupted with detail", async () => {
    observeSqliteStatementError(
      sqliteError("SQLITE_CORRUPT", "database disk image is malformed"),
      {
        sql: "SELECT * FROM messages WHERE id = ?",
        database: "main",
        label: "load-history",
      },
    );
    await flushCorruptionEmitsForTesting();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].checkName).toBe(SQLITE_CORRUPTED_CHECK_NAME);
    expect(emitCalls[0].checkName).toBe("sqlite_corrupted");
    expect(emitCalls[0].detail).toMatchObject({
      database: "main",
      error: "database disk image is malformed",
      sql: "SELECT * FROM messages WHERE id = ?",
      label: "load-history",
    });
  });

  test('falls back to "unknown" when the connection carried no database tag', async () => {
    observeSqliteStatementError(new Error("file is not a database"), {
      sql: "SELECT 1",
    });
    await flushCorruptionEmitsForTesting();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].detail.database).toBe("unknown");
  });

  test("a transient / unrelated error emits nothing", async () => {
    observeSqliteStatementError(sqliteError("SQLITE_BUSY", "locked"), {
      sql: "INSERT ...",
      database: "main",
    });
    observeSqliteStatementError(
      sqliteError("SQLITE_CONSTRAINT", "UNIQUE constraint failed"),
      { sql: "INSERT ...", database: "main" },
    );
    observeSqliteStatementError(new Error("no such table: foo"), {
      sql: "SELECT ...",
      database: "main",
    });
    await flushCorruptionEmitsForTesting();

    expect(emitCalls).toHaveLength(0);
  });

  test("debounces repeated corruption on the same database", async () => {
    const err = sqliteError(
      "SQLITE_CORRUPT",
      "database disk image is malformed",
    );
    observeSqliteStatementError(err, { sql: "SELECT 1", database: "main" });
    observeSqliteStatementError(err, { sql: "SELECT 2", database: "main" });
    observeSqliteStatementError(err, { sql: "SELECT 3", database: "main" });
    await flushCorruptionEmitsForTesting();
    // One report for `main` within the cooldown window...
    expect(emitCalls).toHaveLength(1);

    // ...but a distinct database is still free to report.
    observeSqliteStatementError(err, { sql: "SELECT 1", database: "memory" });
    await flushCorruptionEmitsForTesting();
    expect(emitCalls).toHaveLength(2);
  });
});

describe("wired into the slow-query wrapper", () => {
  beforeEach(() => {
    emitCalls.length = 0;
    resetSqliteCorruptionWatchdogForTesting();
  });

  test("a wrapped connection hitting a corrupt-header file emits, and the error still propagates", async () => {
    // A garbage file throws SQLITE_NOTADB while `.query()` compiles the SQL —
    // the wrapper's create-time seam surfaces it straight to the watchdog, and
    // names the file from the connection's own `filename` (no key plumbing).
    const dir = mkdtempSync(join(tmpdir(), "sqlite-corruption-wd-"));
    const garbagePath = join(dir, "not-a.db");
    writeFileSync(
      garbagePath,
      Buffer.from("this is definitely not a sqlite db"),
    );

    const db = new Database(garbagePath);
    wrapSqliteForSlowQueryLogging(db);

    // The original SQLite error must still propagate unchanged.
    expect(() => db.query("SELECT name FROM sqlite_master").all()).toThrow();
    await flushCorruptionEmitsForTesting();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].checkName).toBe("sqlite_corrupted");
    expect(emitCalls[0].detail.database).toBe("not-a.db");
  });

  test("a wrapped connection running healthy queries emits nothing", async () => {
    const db = new Database(":memory:");
    wrapSqliteForSlowQueryLogging(db);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.query("INSERT INTO t (id) VALUES (1)").run();
    db.query("SELECT * FROM t").all();
    await flushCorruptionEmitsForTesting();

    expect(emitCalls).toHaveLength(0);
  });
});
