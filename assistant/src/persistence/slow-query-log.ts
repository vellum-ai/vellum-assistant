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
 * Attribution: raw-query callers attach a curated `.label()` (e.g.
 * `"schedule:claimDue"`). Wrappers that know the operation they run publish an
 * ambient label ({@link ../util/sqlite-query-label} — e.g. `withSqliteRetry`
 * publishes its `op`), picked up here when no statement label is set. Drizzle's
 * fluent API has no chokepoint to label, so for any query without a label the
 * reporter derives a `caller` from the stack — `path:function:line` of the
 * nearest *named* application frame, so a query issued inside an anonymous
 * transaction callback is attributed to the enclosing function rather than
 * `<anonymous>` — captured only on the slow path. Between the three, every
 * slow query is attributable to its call site with no per-query annotation of
 * Drizzle code.
 *
 * The same per-statement chokepoint also surfaces *failed* executions: when a
 * statement throws, the error is handed to {@link observeSqliteStatementError}
 * before it propagates unchanged. This is how the SQLite corruption watchdog
 * notices `SQLITE_CORRUPT` / `SQLITE_NOTADB` on any query or write — read or
 * write, Drizzle or raw — the moment the workload hits the damaged page.
 *
 * This is pure instrumentation: return values, parameter binding, transactions,
 * savepoints, and error propagation are all preserved exactly. The fast path
 * adds only a `performance.now()` pair and a numeric compare — no allocation,
 * SQL slicing, or observer call happens unless the statement is slow or throws.
 */

import { basename } from "node:path";
import type { Database, Statement } from "bun:sqlite";

import { observeSqliteStatementError } from "../daemon/sqlite-corruption-watchdog.js";
import { getLogger } from "../util/logger.js";
import { getAmbientSqliteQueryLabel } from "../util/sqlite-query-label.js";

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
  /**
   * Caller-supplied attribution tag: the statement's `.label()` when set,
   * otherwise the ambient label published by an enclosing wrapper (e.g.
   * `withSqliteRetry`'s `op` — see {@link ../util/sqlite-query-label}).
   */
  label?: string;
  /**
   * Auto-derived call site (`path:function:line` of the nearest named
   * application frame) for queries with no explicit `.label()` — notably every
   * Drizzle query, which has no chokepoint to attach a label to. Captured from
   * the stack only on the slow path. Present alongside an *ambient* label
   * (which marks an outer boundary, not the statement's own call site) but
   * suppressed by an explicit `.label()`.
   */
  caller?: string;
}

/** This instrumentation module — never the query's call site. */
const SELF_MODULE = "slow-query-log.ts";

/**
 * Marks the assistant package's own source. In local-runtime installs the CLI
 * runs the daemon from `<installDir>/node_modules/@vellumai/assistant/src/…`, so
 * the assistant's own frames also contain `node_modules` — they must NOT be
 * treated as third-party dependency frames when deriving the caller.
 */
const ASSISTANT_SRC_MARKER = "@vellumai/assistant/src/";

/**
 * True for stack frames that are runtime/ORM/instrumentation plumbing rather
 * than the application code that issued the query. Third-party dependency frames
 * (Drizzle et al.) live under `node_modules/` or Bun's global install cache
 * (`.bun/install/cache/drizzle-orm@x.y.z/…`) and are skipped — but the
 * assistant's own packaged `src/` frames, which also live under `node_modules`,
 * are preserved.
 */
function isPlumbingFrame(line: string): boolean {
  // Runtime internals: `node:*` / `bun:*` modules and Bun's `native:` frames
  // (moduleEvaluation, processTicksAndRejections, …).
  if (
    line.includes("node:") ||
    line.includes("bun:") ||
    line.includes("native:")
  ) {
    return true;
  }
  if (line.includes(SELF_MODULE)) return true;
  const isDependency =
    line.includes("node_modules/") || line.includes(".bun/install/cache/");
  return isDependency && !line.includes(ASSISTANT_SRC_MARKER);
}

/** `src/`-relative path, or bare basename when the frame is outside `src/`. */
function shortenStackFile(file: string): string {
  const idx = file.lastIndexOf("/src/");
  if (idx >= 0) return file.slice(idx + "/src/".length);
  return file.split("/").pop() ?? file;
}

/** Function names Bun uses for frames with no name of their own. */
function isAnonymousFunctionName(name: string): boolean {
  return name === "<anonymous>" || name === "anonymous";
}

/**
 * Best-effort attribution for a query with no explicit label: the nearest
 * *named* stack frame outside this module, dependencies, and the runtime —
 * i.e. the application function accountable for the query. Returns e.g.
 * `persistence/conversation-crud.ts:insertMessageCore:474`.
 *
 * Anonymous application frames are skipped in favor of a named frame further
 * up: a statement run inside `db.transaction((tx) => …)` sits in an anonymous
 * callback, and attributing it there (`file:<anonymous>:line`) hides which
 * operation issued it. The innermost anonymous frame is kept as a fallback for
 * stacks with no named application frame at all.
 *
 * Only called on the slow path (a query already past the threshold), so the
 * `Error().stack` cost is incurred rarely. Accepts an explicit `stack` for
 * testing.
 *
 * @internal exported only for unit tests.
 */
export function callerFromStack(
  stack: string | undefined = new Error().stack,
): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n");
  let anonymousFallback: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("at ")) continue;
    if (isPlumbingFrame(line)) continue;
    // Bun renders frames as `at fn (file:line:col)`, `at file:line:col`, or
    // (for some optimized frames) `at file:line` with no function or column.
    const withFn = line.match(
      /at (?:async )?([^\s(]+) \((.+?):(\d+)(?::\d+)?\)/,
    );
    if (withFn) {
      const caller = `${shortenStackFile(withFn[2])}:${withFn[1]}:${withFn[3]}`;
      if (isAnonymousFunctionName(withFn[1])) {
        anonymousFallback ??= caller;
        continue;
      }
      return caller;
    }
    const noFn = line.match(/at (?:async )?(.+?):(\d+)(?::\d+)?$/);
    if (noFn) {
      anonymousFallback ??= `${shortenStackFile(noFn[1])}:${noFn[2]}`;
    }
  }
  return anonymousFallback;
}

/** Log a slow statement execution at WARN with its SQL and duration. */
export function reportSlowQuery(event: SlowQueryEvent): void {
  log.warn(event, "Slow SQLite query blocked the event loop");
}

/** Injectable seams so the wrapper is unit-testable with a fake clock/sink. */
export interface SlowQueryWatcherOptions {
  thresholdMs?: number;
  now?: () => number;
  onSlowQuery?: (event: SlowQueryEvent) => void;
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
  // Reuse the path this connection was opened with (`new Database(path)`) rather
  // than a hand-passed key — its basename names the damaged file.
  const database = basename(sqlite.filename);

  // Slow path only (a statement threw). Surface it to the corruption watchdog;
  // its failure must never escape into the query path.
  const notifyError = (
    err: unknown,
    sql: string,
    label: string | undefined,
  ): void => {
    try {
      observeSqliteStatementError(err, {
        sql: sql.slice(0, SQL_PREVIEW_MAX),
        database,
        ...(label === undefined ? {} : { label }),
      });
    } catch {
      // The observer must never break the query path.
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
    // Only ever called on the slow path, so building the payload — including
    // the ambient-label read and the stack walk for unlabeled (Drizzle)
    // queries — is fine. An explicit `.label()` marks the statement's own
    // call site, so the stack adds nothing; an ambient label marks an outer
    // boundary (e.g. a `withSqliteRetry` op), so the call site is still
    // derived alongside it.
    const effectiveLabel = label ?? getAmbientSqliteQueryLabel();
    const caller = label === undefined ? callerFromStack() : undefined;
    onSlowQuery({
      durationMs,
      sql: sql.slice(0, SQL_PREVIEW_MAX),
      ...(Array.isArray(result) ? { rowCount: result.length } : {}),
      ...(effectiveLabel === undefined ? {} : { label: effectiveLabel }),
      ...(caller === undefined ? {} : { caller }),
    });
  };

  // Statement proxies are cached against their native statement so repeated
  // executions of a `.query()`-cached prepared statement reuse one proxy and its
  // timed closures — nothing allocates on the hot path. The cache is keyed by
  // label as well as statement so a native statement reused under different
  // labels gets one proxy per label (no label leaks across callers), and the
  // labeled hot path (e.g. the raw-query helpers) stays allocation-free too.
  const UNLABELED = "";
  const proxiesByStmt = new WeakMap<Statement, Map<string, Statement>>();

  const wrapStatement = (
    stmt: Statement,
    sql: string,
    label: string | undefined,
  ): Statement => {
    const cacheKey = label ?? UNLABELED;
    let byLabel = proxiesByStmt.get(stmt);
    if (byLabel) {
      const cached = byLabel.get(cacheKey);
      if (cached) return cached;
    } else {
      byLabel = new Map();
      proxiesByStmt.set(stmt, byLabel);
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

    byLabel.set(cacheKey, proxy);
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
