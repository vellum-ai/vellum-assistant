/**
 * Per-statement duration logging for every `bun:sqlite` query — Drizzle and raw.
 *
 * `bun:sqlite` executes synchronously on the daemon's single event-loop thread,
 * so any statement that runs long — a large history scan, a memory query, or a
 * write that blocks on the WAL write-lock (`busy_timeout` makes a contended
 * writer *wait*, spinning the loop for up to {@link SQLITE_BUSY_TIMEOUT_MS}) —
 * freezes every other handler (SSE, HTTP, health) for its full duration. The
 * event-loop watchdog can see *that* a freeze happened but not *what* ran, and
 * the section-level {@link ./slow-sync-log timeSyncSection} only covers the few
 * call sites that opt in — notably not the Drizzle ORM hot writers.
 *
 * {@link wrapSqliteForSlowQueryLogging} closes that gap by wrapping the three
 * statement-execution entry points on a `Database` — `.query()`, `.prepare()`,
 * and the `.run()` shortcut — so that every execution (`.run()/.get()/.all()/
 * .values()`) is timed with `performance.now()`. Executions slower than
 * {@link SLOW_QUERY_THRESHOLD_MS} are logged at WARN with the offending SQL,
 * naming the specific query behind a freeze regardless of whether it came from
 * Drizzle or {@link ./raw-query}.
 *
 * The same per-statement chokepoint also surfaces *failed* executions: when a
 * statement throws, the error is handed to an optional {@link StatementErrorObserver}
 * (registered via {@link setStatementErrorObserver}) before it propagates
 * unchanged. This is how the SQLite corruption watchdog notices
 * `SQLITE_CORRUPT` / `SQLITE_NOTADB` on any query or write — read or write,
 * Drizzle or raw — without a polling `integrity_check` loop that would itself
 * block the event loop. The wrapper stays decoupled from telemetry: it just
 * reports the error to whoever registered.
 *
 * This is pure instrumentation: return values, parameter binding, transactions,
 * savepoints, and error propagation are all preserved exactly. The fast path
 * adds only a `performance.now()` pair and a numeric compare — no allocation,
 * SQL slicing, or observer call happens unless the statement is slow or throws.
 */

import type { Database, Statement } from "bun:sqlite";

import { getLogger } from "../util/logger.js";

const log = getLogger("slow-query");

// Parsed once at module load; falls back below for any non-positive or
// unparseable value.
const configuredThresholdMs = Number(
  process.env.VELLUM_SLOW_QUERY_THRESHOLD_MS,
);

/**
 * Statement executions that block the event loop at least this long are logged.
 * Deliberately conservative (300ms) so it names sub-watchdog contributors
 * without logging every fast query. Env-overridable for tuning on a busy host
 * without a rebuild.
 */
export const SLOW_QUERY_THRESHOLD_MS =
  Number.isFinite(configuredThresholdMs) && configuredThresholdMs > 0
    ? configuredThresholdMs
    : 300;

/** Max SQL characters retained in the log preview. */
const SQL_PREVIEW_MAX = 120;

/** The statement methods that actually execute SQL and can block. */
const TIMED_METHODS = new Set(["run", "get", "all", "values"]);

/** A slow statement execution, as handed to {@link reportSlowQuery}. */
export interface SlowQueryEvent {
  durationMs: number;
  /** SQL preview (first {@link SQL_PREVIEW_MAX} chars). */
  sql: string;
  /** Number of rows returned, when the execution produced an array result. */
  rowCount?: number;
  /** Caller-supplied attribution tag, when the query was issued via `.label()`. */
  label?: string;
}

/** Log a slow statement execution at WARN with its SQL and duration. */
export function reportSlowQuery(event: SlowQueryEvent): void {
  log.warn(event, "Slow SQLite query blocked the event loop");
}

/** Context handed to a {@link StatementErrorObserver} for a failed execution. */
export interface StatementErrorContext {
  /** SQL preview (first {@link SQL_PREVIEW_MAX} chars) of the failing statement. */
  sql: string;
  /**
   * Identifier of the database file the connection targets ("main" / "logs" /
   * "memory" / "telemetry"), when {@link wrapSqliteForSlowQueryLogging} was
   * told which one. Absent on connections wrapped without a `database` option.
   */
  database?: string;
  /** Caller-supplied `.label()` attribution tag, when present. */
  label?: string;
}

/**
 * Notified when a wrapped statement execution throws, before the error
 * propagates unchanged. Registered process-wide via
 * {@link setStatementErrorObserver}; the wrapper itself stays ignorant of what
 * the observer does with the error (the corruption watchdog registers one).
 */
export type StatementErrorObserver = (
  err: unknown,
  context: StatementErrorContext,
) => void;

let statementErrorObserver: StatementErrorObserver | null = null;

/**
 * Register (or clear, with `null`) the process-wide {@link StatementErrorObserver}.
 * Read at execution time, so a connection wrapped before the observer is
 * registered still reports later failures — the daemon wraps connections at
 * construction and registers the observer at boot.
 */
export function setStatementErrorObserver(
  observer: StatementErrorObserver | null,
): void {
  statementErrorObserver = observer;
}

/** Injectable seams so the wrapper is unit-testable with a fake clock/sink. */
export interface SlowQueryWatcherOptions {
  thresholdMs?: number;
  now?: () => number;
  onSlowQuery?: (event: SlowQueryEvent) => void;
  /** Database-file identifier tagged onto slow-query and error reports. */
  database?: string;
  /** Test seam: overrides the module-level {@link StatementErrorObserver}. */
  onStatementError?: StatementErrorObserver;
}

/** Fluent handle returned by {@link Database.label}; tags any slow-query log. */
export interface LabeledQueries {
  query(sql: string, ...rest: unknown[]): Statement;
  prepare(sql: string, ...rest: unknown[]): Statement;
  run(sql: string, ...params: unknown[]): ReturnType<Database["run"]>;
}

declare module "bun:sqlite" {
  interface Database {
    /**
     * Return `query`/`prepare`/`run` bound to `label`, so any slow-query log
     * emitted for statements created through the returned handle carries it —
     * e.g. `getSqlite().label("schedule::claimDue").query(sql).run(...)`.
     * Only present on connections wrapped by
     * {@link wrapSqliteForSlowQueryLogging} (all accessor connections).
     */
    label(label: string): LabeledQueries;
  }
}

/**
 * Wrap a `bun:sqlite` {@link Database} in place so every statement execution is
 * timed and the slow ones are logged. The Drizzle path (`.prepare(sql)` then
 * `.run()/.all()/.values()`), {@link ./raw-query} (`.query(sql).get()/.all()/
 * .run()`), and the `Database.run(sql, params)` shortcut (used by migration
 * code via `getSqliteFrom(db).run(...)`) all route through the entry points
 * wrapped here, so a single call covers every path.
 *
 * Returns the same instance (mutated), so callers can wrap inline at
 * construction. `.exec()` — batch DDL, PRAGMAs, and transaction `BEGIN`/`COMMIT`
 * — is intentionally left unwrapped: it takes no bindings and isn't a
 * statement-execution path. `options` exists only for tests.
 */
export function wrapSqliteForSlowQueryLogging(
  sqlite: Database,
  options: SlowQueryWatcherOptions = {},
): Database {
  const thresholdMs = options.thresholdMs ?? SLOW_QUERY_THRESHOLD_MS;
  const now = options.now ?? (() => performance.now());
  const onSlowQuery = options.onSlowQuery ?? reportSlowQuery;
  const database = options.database;

  // Slow path only (a statement threw). Resolves the observer at call time so
  // late module-level registration is honored, and never lets an observer
  // failure escape into the query path.
  const notifyError = (
    err: unknown,
    sql: string,
    label: string | undefined,
  ): void => {
    const observer = options.onStatementError ?? statementErrorObserver;
    if (!observer) return;
    try {
      observer(err, {
        sql: sql.slice(0, SQL_PREVIEW_MAX),
        ...(database === undefined ? {} : { database }),
        ...(label === undefined ? {} : { label }),
      });
    } catch {
      // An observer must never break the query path.
    }
  };

  // Re-entrancy guard. `bun:sqlite` implements `db.query(sql).run()` by
  // delegating through the (also-wrapped) `db.prepare(sql)`, so the outer
  // `.run()` would time the inner `.run()` a second time. Because `bun:sqlite`
  // is fully synchronous, a per-connection flag safely collapses that nesting:
  // only the outermost execution is timed (its duration already includes any
  // inner re-prepare), inner ones pass straight through. Not shared across
  // connections so tests stay isolated.
  let timing = false;

  const emit = (
    sql: string,
    label: string | undefined,
    durationMs: number,
    result: unknown,
  ): void => {
    // Only ever called on the slow path, so building the payload here is fine.
    onSlowQuery({
      durationMs,
      sql: sql.slice(0, SQL_PREVIEW_MAX),
      ...(Array.isArray(result) ? { rowCount: result.length } : {}),
      ...(label === undefined ? {} : { label }),
    });
  };

  // Unlabeled statement proxies are cached against their native statement so
  // repeated executions of a `.query()`-cached prepared statement reuse one
  // proxy and its timed closures — nothing allocates on the hot path. Labeled
  // statements are opt-in attribution created fresh (a native statement shared
  // across labels must not leak the first label), so they skip this cache.
  const unlabeledProxies = new WeakMap<Statement, Statement>();

  const wrapStatement = (
    stmt: Statement,
    sql: string,
    label: string | undefined,
  ): Statement => {
    if (label === undefined) {
      const cached = unlabeledProxies.get(stmt);
      if (cached) return cached;
    }

    const timed = new Map<string, (...args: unknown[]) => unknown>();
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (typeof prop === "string" && TIMED_METHODS.has(prop)) {
          let fn = timed.get(prop);
          if (!fn) {
            const call = (
              target as unknown as Record<string, (...a: unknown[]) => unknown>
            )[prop].bind(target);
            fn = (...args: unknown[]): unknown => {
              if (timing) return call(...args); // inner re-entry: no timing
              timing = true;
              const start = now();
              let result: unknown;
              try {
                result = call(...args);
                return result;
              } catch (err) {
                // The failed op still blocked and still needs timing (below);
                // surface it to the error observer before it propagates
                // unchanged. Re-entrant inner calls short-circuit above
                // (`if (timing)`), so a nested throw is observed once, here.
                notifyError(err, sql, label);
                throw err;
              } finally {
                timing = false;
                // Fast path: one subtraction + one compare. Nothing is
                // allocated or sliced unless we cross the threshold.
                const durationMs = now() - start;
                if (durationMs >= thresholdMs) {
                  emit(sql, label, durationMs, result);
                }
              }
            };
            timed.set(prop, fn);
          }
          return fn;
        }
        // Everything else (columnNames, paramsCount, finalize, toString, …)
        // passes straight through, bound to the real statement so native
        // methods keep their `this`.
        const value = Reflect.get(target, prop, target);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });

    if (label === undefined) unlabeledProxies.set(stmt, proxy);
    return proxy;
  };

  const originalQuery = sqlite.query.bind(sqlite);
  const originalPrepare = sqlite.prepare.bind(sqlite);
  const originalRun = sqlite.run.bind(sqlite);

  // `.query()` / `.prepare()` compile the SQL, which reads the schema — on a
  // file with a corrupt header ("file is not a database") that read throws
  // *here*, before any execution method runs, so the error is surfaced to the
  // observer at creation time too. (Malformed-*page* corruption instead
  // surfaces at step time and is caught in the execution closures above.) A
  // `query()` that delegates through the wrapped `prepare()` may notify twice;
  // the observer's per-database debounce collapses that to one report.
  const createStatement = (
    create: (...a: unknown[]) => Statement,
    sql: string,
    label: string | undefined,
    rest: unknown[],
  ): Statement => {
    let stmt: Statement;
    try {
      stmt = create(sql, ...rest);
    } catch (err) {
      notifyError(err, sql, label);
      throw err;
    }
    return wrapStatement(stmt, sql, label);
  };

  const makeQuery =
    (label: string | undefined) =>
    (sql: string, ...rest: unknown[]): Statement =>
      createStatement(
        originalQuery as (...a: unknown[]) => Statement,
        sql,
        label,
        rest,
      );

  const makePrepare =
    (label: string | undefined) =>
    (sql: string, ...rest: unknown[]): Statement =>
      createStatement(
        originalPrepare as (...a: unknown[]) => Statement,
        sql,
        label,
        rest,
      );

  // `Database.run(sql, ...params)` is a native shortcut that does not route
  // through `.prepare()`, so it is timed directly here. `sql` is an argument
  // (not fixed per closure), so one closure per label reads it from the call.
  const makeRun =
    (label: string | undefined) =>
    (sql: string, ...params: unknown[]): unknown => {
      const call = originalRun as (...a: unknown[]) => unknown;
      if (timing) return call(sql, ...params);
      timing = true;
      const start = now();
      let result: unknown;
      try {
        result = call(sql, ...params);
        return result;
      } catch (err) {
        notifyError(err, sql, label);
        throw err;
      } finally {
        timing = false;
        const durationMs = now() - start;
        if (durationMs >= thresholdMs) emit(sql, label, durationMs, result);
      }
    };

  sqlite.query = makeQuery(undefined) as typeof sqlite.query;
  sqlite.prepare = makePrepare(undefined) as typeof sqlite.prepare;
  sqlite.run = makeRun(undefined) as typeof sqlite.run;
  sqlite.label = (label: string): LabeledQueries => ({
    query: makeQuery(label),
    prepare: makePrepare(label),
    run: makeRun(label) as LabeledQueries["run"],
  });

  return sqlite;
}
