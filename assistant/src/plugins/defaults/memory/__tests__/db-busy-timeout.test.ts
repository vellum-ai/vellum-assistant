/**
 * Locks in that every assistant SQLite connection shares one busy_timeout.
 *
 * `runAsyncSqlite` can open an out-of-process (sqlite3 CLI) or transient
 * in-process connection that writes the same database file as the live
 * daemon connection. If those connections don't wait the same amount of
 * time for a lock, a concurrent writer fails immediately with SQLITE_BUSY
 * instead of waiting its turn. The shared `SQLITE_BUSY_TIMEOUT_MS` constant
 * is the single source of truth; this test guards against the live daemon
 * connection drifting away from it.
 */
import { expect, test } from "bun:test";

const { getSqlite, SQLITE_BUSY_TIMEOUT_MS } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");

await initializeDb();

test("the daemon connection runs with the shared busy_timeout", () => {
  const sqlite = getSqlite();
  const value = (
    sqlite.query("PRAGMA busy_timeout").get() as { timeout: number }
  ).timeout;
  expect(value).toBe(SQLITE_BUSY_TIMEOUT_MS);
});
