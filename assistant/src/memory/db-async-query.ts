/**
 * Run a SQL statement asynchronously, without blocking the daemon's
 * main event loop.
 *
 * `bun:sqlite` is synchronous, so any long-running statement on the
 * shared in-process connection stalls the event loop for the full
 * duration of the statement. For multi-minute operations like `VACUUM`
 * on a multi-GB database, this stalls every other piece of I/O —
 * including the healthz handler — and on platform that has been
 * observed to fail liveness probes and crashloop the pod.
 *
 * Backend selection:
 *   1. **`sqlite3` CLI subprocess (preferred).** Spawn a child process
 *      that opens its own SQLite connection, runs the statement, and
 *      exits. The daemon's event loop is free for the full duration.
 *      SQLite's own file-locking arbitrates between the subprocess and
 *      the still-running in-process connection.
 *   2. **In-process `bun:sqlite` (fallback).** Synchronous, blocking.
 *      Only fires when no `sqlite3` binary is on the host. This is the
 *      same behavior the daemon had before this abstraction existed,
 *      and is acceptable on desktop where no liveness probe is going to
 *      kill the process for a long stall.
 *
 * Use this for statements known to be slow (`VACUUM`, `ANALYZE`,
 * `PRAGMA optimize`, large bulk `DELETE`/`UPDATE`). Fast queries (a few
 * ms) should keep using the in-process drizzle / `bun:sqlite` handle
 * directly — the subprocess overhead would dominate.
 */
import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { findSqlite3 } from "../util/sqlite3-runtime.js";
import { getSqlite } from "./db-connection.js";

const log = getLogger("db-async-query");

/**
 * Default wall-clock cap for an async statement. A real `VACUUM` on a
 * multi-GB database can legitimately take many minutes; the cap is
 * here to bound a runaway subprocess (e.g. one stuck on a stale file
 * lock). Override per call via `runAsyncSqlite(sql, { timeoutMs })`.
 */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export type AsyncSqliteBackend = "sqlite3-cli" | "in-process-blocking";

export interface AsyncSqliteResult {
  ok: boolean;
  backend: AsyncSqliteBackend;
  error: string | null;
  elapsedMs: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

export interface RunAsyncSqliteOptions {
  /** Override the default 1 h subprocess timeout. */
  timeoutMs?: number;
  /**
   * Force a specific backend. Test-only; production callers should let
   * the runtime pick.
   */
  forceBackend?: AsyncSqliteBackend;
}

let warnedAboutFallback = false;

export async function runAsyncSqlite(
  sql: string,
  options: RunAsyncSqliteOptions = {},
): Promise<AsyncSqliteResult> {
  const forced = options.forceBackend;
  const sqlite3Path =
    forced === "in-process-blocking" ? undefined : findSqlite3();

  if (sqlite3Path && forced !== "in-process-blocking") {
    return runViaCli(sqlite3Path, sql, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    log.warn(
      "No sqlite3 CLI found on host — falling back to in-process blocking " +
        "execution for slow SQLite statements. Install sqlite3 to keep the " +
        "event loop responsive during VACUUM and other long operations.",
    );
  }
  return runInProcessBlocking(sql);
}

/** For tests: reset the once-only fallback warning. */
export function _resetFallbackWarning(): void {
  warnedAboutFallback = false;
}

async function runViaCli(
  sqlite3Path: string,
  sql: string,
  timeoutMs: number,
): Promise<AsyncSqliteResult> {
  const startMs = Date.now();
  const dbPath = getDbPath();

  log.info(
    { sqlite3Path, dbPath, timeoutMs, sqlPreview: sql.slice(0, 80) },
    "Running async SQL via sqlite3 CLI subprocess",
  );

  // Pass the SQL via stdin rather than -cmd so newlines and quoting are
  // never an issue regardless of the statement complexity.
  const proc = Bun.spawn({
    cmd: [sqlite3Path, dbPath],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Write the SQL and close stdin so sqlite3 sees EOF and exits.
  proc.stdin.write(sql + "\n");
  await proc.stdin.end();

  // Begin draining the streams immediately so the subprocess never
  // blocks on a full pipe buffer.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  const elapsedMs = Date.now() - startMs;

  if (timedOut) {
    log.error(
      { timeoutMs, elapsedMs, stderr: stderr.slice(0, 2000) },
      "Async SQL subprocess timed out — killed",
    );
    return {
      ok: false,
      backend: "sqlite3-cli",
      error: `sqlite3 subprocess timed out after ${timeoutMs}ms`,
      elapsedMs,
      stdout,
      stderr,
      timedOut: true,
    };
  }
  if (exitCode !== 0) {
    log.error(
      { exitCode, elapsedMs, stderr: stderr.slice(0, 2000) },
      "Async SQL subprocess failed",
    );
    return {
      ok: false,
      backend: "sqlite3-cli",
      error: `sqlite3 exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
      elapsedMs,
      stdout,
      stderr,
    };
  }
  return {
    ok: true,
    backend: "sqlite3-cli",
    error: null,
    elapsedMs,
    stdout,
    stderr,
  };
}

async function runInProcessBlocking(sql: string): Promise<AsyncSqliteResult> {
  const startMs = Date.now();
  try {
    const sqlite = getSqlite();
    sqlite.exec(sql);
    // Synthesize `stdout` to match what the CLI backend would emit
    // when the caller chained `SELECT changes();` at the end of their
    // SQL. `bun:sqlite`'s `exec()` discards SELECT results, so without
    // this synthesis, callers that read `stdout` to get the row count
    // (the prune jobs in cleanup.ts, for one) would see `undefined`
    // and treat the run as "no rows deleted" — silently dropping the
    // re-enqueue gate on every fallback host. Captured atomically with
    // exec (same synchronous slice — no other code can run between
    // these two lines), so the count is accurate for the SQL we just
    // ran. Harmless for callers that don't read stdout.
    const changes = (
      sqlite.query("SELECT changes() AS c").get() as { c: number }
    ).c;
    return {
      ok: true,
      backend: "in-process-blocking",
      error: null,
      elapsedMs: Date.now() - startMs,
      stdout: `${changes}\n`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      backend: "in-process-blocking",
      error: message,
      elapsedMs: Date.now() - startMs,
    };
  }
}
