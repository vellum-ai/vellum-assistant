/**
 * Tests for the SQLite corruption watchdog.
 *
 * The watchdog turns a `SQLITE_CORRUPT` / `SQLITE_NOTADB` error thrown by any
 * statement into a `watchdog` telemetry event with
 * `check_name = "sqlite_corrupted"`. It must flow through the same
 * `recordWatchdogEvent` path (and therefore the same usage-data opt-out gate)
 * as the event-loop watchdog, ignore non-corruption errors, and debounce per
 * database so a corrupt file throwing on every statement reports once.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Sentry is a side-effecting no-op in tests.
mock.module("@sentry/node", () => ({
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setLevel() {}, setTag() {}, setContext() {} }),
  captureMessage: () => {},
}));

let shareAnalytics = true;
mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => shareAnalytics,
}));

import { getTelemetryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { watchdogEvents } from "../persistence/schema/index.js";
import { queryUnreportedWatchdogEvents } from "../telemetry/watchdog-events-store.js";
import {
  isSqliteCorruptionError,
  observeSqliteStatementError,
  resetSqliteCorruptionWatchdogForTesting,
  SQLITE_CORRUPTED_CHECK_NAME,
} from "./sqlite-corruption-watchdog.js";

await initializeDb();

function recordedEvents() {
  return queryUnreportedWatchdogEvents(0, undefined, 100);
}

function clearEvents(): void {
  const db = getTelemetryDb();
  if (!db) {
    throw new Error("telemetry DB unavailable in test");
  }
  db.delete(watchdogEvents).run();
}

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

describe("emission", () => {
  beforeEach(() => {
    shareAnalytics = true;
    clearEvents();
    resetSqliteCorruptionWatchdogForTesting();
  });

  test("a corruption error from any statement emits sqlite_corrupted", () => {
    observeSqliteStatementError(
      sqliteError("SQLITE_CORRUPT", "database disk image is malformed"),
      {
        sql: "SELECT * FROM messages WHERE id = ?",
        database: "main",
        label: "load-history",
      },
    );

    const rows = recordedEvents();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.checkName).toBe(SQLITE_CORRUPTED_CHECK_NAME);
    expect(row.checkName).toBe("sqlite_corrupted");
    // The chart does not use `value`; it is left null.
    expect(row.value).toBeNull();
    const detail = JSON.parse(row.detail!) as Record<string, unknown>;
    expect(detail.database).toBe("main");
    expect(detail.error).toBe("database disk image is malformed");
    expect(detail.sql).toBe("SELECT * FROM messages WHERE id = ?");
    expect(detail.label).toBe("load-history");
  });

  test('falls back to "unknown" when the connection carried no database tag', () => {
    observeSqliteStatementError(new Error("file is not a database"), {
      sql: "SELECT 1",
    });

    const rows = recordedEvents();
    expect(rows).toHaveLength(1);
    const detail = JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
    expect(detail.database).toBe("unknown");
  });

  test("a transient / unrelated error emits nothing", () => {
    observeSqliteStatementError(
      sqliteError("SQLITE_BUSY", "database is locked"),
      { sql: "INSERT ...", database: "main" },
    );
    observeSqliteStatementError(
      sqliteError("SQLITE_CONSTRAINT", "UNIQUE constraint failed"),
      { sql: "INSERT ...", database: "main" },
    );
    observeSqliteStatementError(new Error("no such table: foo"), {
      sql: "SELECT ...",
      database: "main",
    });

    expect(recordedEvents()).toHaveLength(0);
  });

  test("honors the usage-data opt-out (records nothing)", () => {
    shareAnalytics = false;
    observeSqliteStatementError(
      sqliteError("SQLITE_CORRUPT", "database disk image is malformed"),
      { sql: "SELECT 1", database: "main" },
    );

    expect(recordedEvents()).toHaveLength(0);
  });

  test("debounces repeated corruption on the same database", () => {
    const err = sqliteError(
      "SQLITE_CORRUPT",
      "database disk image is malformed",
    );
    observeSqliteStatementError(err, { sql: "SELECT 1", database: "main" });
    observeSqliteStatementError(err, { sql: "SELECT 2", database: "main" });
    observeSqliteStatementError(err, { sql: "SELECT 3", database: "main" });

    // One report for `main` within the cooldown window...
    expect(recordedEvents()).toHaveLength(1);

    // ...but a distinct database is still free to report.
    observeSqliteStatementError(err, { sql: "SELECT 1", database: "memory" });
    expect(recordedEvents()).toHaveLength(2);
  });
});
