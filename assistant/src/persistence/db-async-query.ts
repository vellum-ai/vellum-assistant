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
import { spawn } from "node:child_process";
import { Database } from "bun:sqlite";

import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { findSqlite3 } from "../util/sqlite3-runtime.js";
import { getSqlite, SQLITE_BUSY_TIMEOUT_MS } from "./db-connection.js";

const log = getLogger("db-async-query");

/**
 * Default wall-clock cap for an async statement. A real `VACUUM` on a
 * multi-GB database can legitimately take many minutes; the cap is
 * here to bound a runaway subprocess (e.g. one stuck on a stale file
 * lock). Override per call via `runAsyncSqlite(sql, { timeoutMs })`.
 */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

/**
 * A successful async statement that runs longer than this is logged at WARN.
 * These dispatches are meant to be heavy-but-bounded; crossing this threshold
 * is a signal worth surfacing (lock contention, an unexpectedly large sweep,
 * a degraded disk) even when the statement ultimately succeeds.
 */
const SLOW_WRITE_WARN_MS = 2000;

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
  /**
   * Database file to run the statement against. Defaults to the main
   * assistant DB (`getDbPath()`). Pass `getLogsDbPath()` / `getMemoryDbPath()`
   * to target a dedicated file directly.
   *
   * The `sqlite3-cli` backend opens the given file as its own `main` database —
   * so a statement like `DELETE FROM llm_request_logs` runs against the right
   * file. The in-process fallback opens a transient `bun:sqlite` connection to
   * this file when set (rather than reusing the daemon connection), so the
   * statement still hits the correct database now that the daemon connection no
   * longer ATTACHes the logs/memory files.
   */
  dbPath?: string;
  /**
   * Extra databases to `ATTACH` before running `sql`, used for cross-database
   * statements (e.g. copying rows from `main` into a dedicated file). Each
   * entry is emitted as an `ATTACH DATABASE '<path>' AS <alias>` prefix on both
   * backends: the `sqlite3-cli` backend prefixes the SQL it pipes in, and the
   * in-process fallback opens a transient connection to `dbPath` and ATTACHes
   * each entry before running the statement.
   *
   * Reference tables by their **unqualified** name in `sql`: a table that
   * exists in exactly one schema resolves unambiguously, so the alias chosen
   * here does not have to match any particular schema name.
   */
  attach?: ReadonlyArray<{ path: string; alias: string }>;
}

let warnedAboutFallback = false;

export async function runAsyncSqlite(
  sql: string,
  label: string,
  options: RunAsyncSqliteOptions = {},
): Promise<AsyncSqliteResult> {
  const forced = options.forceBackend;
  const sqlite3Path =
    forced === "in-process-blocking" ? undefined : findSqlite3();

  let result: AsyncSqliteResult;
  if (sqlite3Path && forced !== "in-process-blocking") {
    const attachPrefix = (options.attach ?? [])
      .map(
        (a) =>
          `ATTACH DATABASE '${a.path.replace(/'/g, "''")}' AS ${a.alias};\n`,
      )
      .join("");
    result = await runViaCli(
      sqlite3Path,
      attachPrefix + sql,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.dbPath ?? getDbPath(),
      label,
    );
  } else {
    if (!warnedAboutFallback) {
      warnedAboutFallback = true;
      log.warn(
        "No sqlite3 CLI found on host — falling back to in-process blocking " +
          "execution for slow SQLite statements. Install sqlite3 to keep the " +
          "event loop responsive during VACUUM and other long operations.",
      );
    }
    result = await runInProcessBlocking(sql, options);
  }

  if (result.ok && result.elapsedMs > SLOW_WRITE_WARN_MS) {
    log.warn(
      { label, elapsedMs: result.elapsedMs, backend: result.backend },
      "Async SQL completed but exceeded slow-write threshold",
    );
  }
  return result;
}

/** For tests: reset the once-only fallback warning. */
export function _resetFallbackWarning(): void {
  warnedAboutFallback = false;
}

/**
 * Parse the integer printed by a trailing `SELECT changes();` in the SQL run
 * through {@link runAsyncSqlite}. Both backends surface it the same way: the
 * `sqlite3` CLI prints a bare integer line, and the in-process fallback
 * synthesizes one. Tolerates blank/incidental lines by scanning from the end
 * for the last numeric line; returns 0 when nothing parseable is found, which
 * callers treat as "no rows affected".
 */
export function parseChangesFromStdout(stdout: string | undefined): number {
  if (!stdout) return 0;
  const lines = stdout.split(/\r?\n/).filter((s) => s.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = parseInt(lines[i].trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

async function runViaCli(
  sqlite3Path: string,
  sql: string,
  timeoutMs: number,
  dbPath: string,
  label: string,
): Promise<AsyncSqliteResult> {
  const startMs = Date.now();

  log.info(
    { label, sqlite3Path, dbPath, timeoutMs, sqlPreview: sql.slice(0, 80) },
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

  // Match the daemon connection's pragmas (`applyConnectionPragmas`) so this
  // subprocess writes like every other connection. `busy_timeout` makes it
  // wait for — rather than instantly fail against — a lock held by the
  // still-running in-process connection (and vice versa).
  // `synchronous=NORMAL` overrides the CLI default (FULL), which would fsync
  // the WAL inside every commit's write-lock window and stretch bulk-batch
  // lock holds under I/O pressure: in WAL mode, NORMAL commits become durable
  // at checkpoint (an OS/power crash can lose the last commits, never
  // corrupt) — the durability posture every daemon write already has, so
  // FULL here buys no end-to-end guarantee. Prepended to the piped SQL so
  // both take effect before the statement runs.
  const sqlWithPragma = `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};\nPRAGMA synchronous=NORMAL;\n${sql}`;

  // Write the SQL and close stdin so sqlite3 sees EOF and exits.
  proc.stdin.write(sqlWithPragma + "\n");
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
      { label, timeoutMs, elapsedMs, stderr: stderr.slice(0, 2000) },
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
      { label, exitCode, elapsedMs, stderr: stderr.slice(0, 2000) },
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

async function runInProcessBlocking(
  sql: string,
  options: RunAsyncSqliteOptions,
): Promise<AsyncSqliteResult> {
  const startMs = Date.now();

  // When `dbPath`/`attach` are set the statement targets a dedicated file (or
  // copies across files), which the daemon connection can no longer reach — it
  // ATTACHes nothing. Open a transient connection to that file and ATTACH each
  // extra database so the unqualified table names resolve, mirroring the
  // sqlite3-cli backend. With neither option set the statement is a plain
  // main-DB op, so reuse the daemon connection (no extra open).
  const usesDedicatedFile = options.dbPath !== undefined || !!options.attach;
  let transient: Database | undefined;

  try {
    let sqlite: Database;
    if (usesDedicatedFile) {
      transient = new Database(options.dbPath ?? getDbPath());
      // Match the daemon connection's busy_timeout and synchronous pragmas so
      // this transient connection waits for locks and commits like every
      // other writer (see the runViaCli prelude for the synchronous=NORMAL
      // rationale). (The daemon connection reused in the else branch already
      // has both set via applyConnectionPragmas.)
      transient.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
      transient.exec("PRAGMA synchronous=NORMAL");
      for (const a of options.attach ?? []) {
        transient.exec(
          `ATTACH DATABASE '${a.path.replace(/'/g, "''")}' AS ${a.alias}`,
        );
      }
      sqlite = transient;
    } else {
      sqlite = getSqlite();
    }

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
  } finally {
    transient?.close();
  }
}

/**
 * Fire-and-forget `PRAGMA wal_checkpoint(TRUNCATE)` against the main
 * assistant DB in a detached `sqlite3` subprocess.
 *
 * For exit paths that cannot wait for a fold to finish (the force-exit
 * timeout in `shutdown-handlers.ts`): the child runs in its own process
 * group with no inherited stdio, so it survives the daemon's `process.exit`
 * — and any group-directed follow-up signal from a supervisor — and
 * finishes the fold in the background. A concurrent checkpointer just makes
 * this one give up after its busy timeout; the fold is best-effort either
 * way, with the pre-open checkpoint in `db-init.ts` as the backstop.
 *
 * Returns false when no `sqlite3` binary is on the host or the spawn fails —
 * there is no in-process fallback because the caller is exiting.
 */
export function spawnDetachedWalCheckpoint(): boolean {
  const sqlite3Path = findSqlite3();
  if (!sqlite3Path) {
    return false;
  }
  try {
    const child = spawn(
      sqlite3Path,
      [
        getDbPath(),
        `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA wal_checkpoint(TRUNCATE);`,
      ],
      { detached: true, stdio: "ignore" },
    );
    // A post-spawn failure can't be acted on — the daemon is exiting — but an
    // unlistened ChildProcess "error" event would throw as an uncaught
    // exception.
    child.on("error", () => {});
    child.unref();
    log.info({ pid: child.pid }, "Spawned detached WAL checkpoint subprocess");
    return true;
  } catch {
    return false;
  }
}
