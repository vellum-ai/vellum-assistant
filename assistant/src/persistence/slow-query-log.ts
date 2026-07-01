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
 * {@link wrapSqliteForSlowQueryLogging} closes that gap by wrapping the two
 * statement factories on a `Database` — `.query()` and `.prepare()` — so that
 * every execution (`.run()/.get()/.all()/.values()`) is timed with
 * `performance.now()`. Executions slower than {@link SLOW_QUERY_THRESHOLD_MS}
 * are logged at WARN with the offending SQL, naming the specific query behind a
 * freeze regardless of whether it came from Drizzle or {@link ./raw-query}.
 *
 * This is pure instrumentation: return values, parameter binding, transactions,
 * savepoints, and error propagation are all preserved exactly. The fast path
 * adds only a `performance.now()` pair and a numeric compare — no allocation or
 * SQL slicing happens unless the threshold is exceeded.
 */

import type { Database, Statement } from "bun:sqlite";

import { getLogger } from "../util/logger.js";

const log = getLogger("slow-query");

/**
 * Statement executions that block the event loop at least this long are logged.
 * Deliberately conservative (300ms) so it names sub-watchdog contributors
 * without logging every fast query. Env-overridable for tuning on a busy host
 * without a rebuild; falls back to 300ms for any non-positive/unparseable value.
 */
export const SLOW_QUERY_THRESHOLD_MS = ((): number => {
  const raw = Number(process.env.VELLUM_SLOW_QUERY_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
})();

/**
 * `check_name` for slow-query telemetry events. Stable so downstream grouping
 * stays consistent; keep it in sync with any admin query.
 */
export const SLOW_QUERY_CHECK_NAME = "slow_sqlite_query";

/** Max SQL characters retained in the log/telemetry preview. */
const SQL_PREVIEW_MAX = 120;

/** The three statement methods that actually execute SQL and can block. */
const TIMED_METHODS = new Set(["run", "get", "all", "values"]);

/** A slow statement execution, as handed to {@link reportSlowQuery}. */
export interface SlowQueryEvent {
  durationMs: number;
  /** SQL preview (first {@link SQL_PREVIEW_MAX} chars). */
  sql: string;
  /** Number of rows returned, when the execution produced an array result. */
  rowCount?: number;
}

/**
 * Log a slow statement execution at WARN and record a `watchdog` telemetry
 * event so the next freeze is attributable to a specific query. Only ever
 * called on the slow path, so building the structured payload here is fine.
 */
export function reportSlowQuery(event: SlowQueryEvent): void {
  log.warn(event, "Slow SQLite query blocked the event loop");
  // Record telemetry via a lazy dynamic import, mirroring slow-sync-log.ts: a
  // static import would pull the telemetry → consent-cache → config/loader
  // chain into the module graph of every DB caller, where a test's
  // `mock.module` of the loader leaks across the shared test process. Loading
  // it only on the rare slow path keeps that chain off the hot static graph;
  // best-effort, so a failure never escapes the timed section.
  void import("../telemetry/watchdog-events-store.js")
    .then(({ recordWatchdogEvent }) => {
      recordWatchdogEvent({
        checkName: SLOW_QUERY_CHECK_NAME,
        value: event.durationMs,
        detail:
          event.rowCount === undefined
            ? { sql: event.sql }
            : { sql: event.sql, rowCount: event.rowCount },
      });
    })
    .catch(() => {
      // Telemetry is best-effort — never let it escape the timed section.
    });
}

/** Injectable seams so the wrapper is unit-testable with a fake clock/sink. */
export interface SlowQueryWatcherOptions {
  thresholdMs?: number;
  now?: () => number;
  onSlowQuery?: (event: SlowQueryEvent) => void;
}

// A wrapped statement is cached against its native statement so repeated
// executions of a `.query()`-cached prepared statement don't re-allocate the
// proxy or its timed method closures on the hot path. Keyed weakly so finalized
// statements can be collected.
type Wrapper = (stmt: Statement, sql: string) => Statement;

/**
 * Build the statement-wrapping function that times executions. Separated from
 * {@link wrapSqliteForSlowQueryLogging} so tests can drive it with a fake clock
 * and a capturing sink instead of the real logger/telemetry.
 */
function makeStatementWrapper(options: SlowQueryWatcherOptions): Wrapper {
  const thresholdMs = options.thresholdMs ?? SLOW_QUERY_THRESHOLD_MS;
  const now = options.now ?? (() => performance.now());
  const onSlowQuery = options.onSlowQuery ?? reportSlowQuery;

  const wrapped = new WeakMap<Statement, Statement>();

  // A single user-initiated execution can re-enter this wrapper: `bun:sqlite`
  // implements `db.query(sql).run()` by delegating through `db.prepare(sql)`,
  // which we also wrap, so the outer `.run()` would time the inner `.run()` a
  // second time. Because `bun:sqlite` is fully synchronous, a per-connection
  // flag safely collapses that nesting: only the outermost execution is timed
  // (its duration already includes any inner re-prepare), inner ones pass
  // straight through. Not shared across connections so tests stay isolated.
  let timing = false;

  return function wrapStatement(stmt: Statement, sql: string): Statement {
    const cached = wrapped.get(stmt);
    if (cached) return cached;

    // Per-statement cache of the timed method closures, so accessing e.g.
    // `.all` repeatedly on a hot prepared statement reuses one closure rather
    // than allocating on each execution.
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
              } finally {
                timing = false;
                // Fast path: one subtraction + one compare. Nothing is
                // allocated or sliced unless we cross the threshold. A thrown
                // error still lands here (the failed op still blocked) and is
                // reported before `finally` lets it propagate unchanged.
                const durationMs = now() - start;
                if (durationMs >= thresholdMs) {
                  onSlowQuery({
                    durationMs,
                    sql: sql.slice(0, SQL_PREVIEW_MAX),
                    rowCount: Array.isArray(result) ? result.length : undefined,
                  });
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

    wrapped.set(stmt, proxy);
    return proxy;
  };
}

/**
 * Wrap a `bun:sqlite` {@link Database} in place so every statement produced by
 * `.query()` / `.prepare()` times its executions and logs the slow ones. Both
 * the Drizzle ORM path (which calls `.prepare(sql)` then `.run()/.all()/
 * .values()`) and {@link ./raw-query} (which calls `.query(sql).get()/.all()/
 * .run()`) route through these two factories, so a single wrap covers both.
 *
 * Returns the same instance (mutated), so callers can wrap inline at
 * construction. `.exec()` — used for batch DDL, PRAGMAs, and transaction
 * `BEGIN`/`COMMIT` — is intentionally left unwrapped: it takes no bindings and
 * isn't a statement-execution path. `options` exists only for tests.
 */
export function wrapSqliteForSlowQueryLogging(
  sqlite: Database,
  options: SlowQueryWatcherOptions = {},
): Database {
  const wrapStatement = makeStatementWrapper(options);

  const originalQuery = sqlite.query.bind(sqlite);
  const originalPrepare = sqlite.prepare.bind(sqlite);

  sqlite.query = ((sql: string, ...rest: unknown[]) =>
    wrapStatement(
      (originalQuery as (...a: unknown[]) => Statement)(sql, ...rest),
      sql,
    )) as typeof sqlite.query;

  sqlite.prepare = ((sql: string, ...rest: unknown[]) =>
    wrapStatement(
      (originalPrepare as (...a: unknown[]) => Statement)(sql, ...rest),
      sql,
    )) as typeof sqlite.prepare;

  return sqlite;
}
