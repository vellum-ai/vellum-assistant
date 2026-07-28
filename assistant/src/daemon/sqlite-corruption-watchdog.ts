/**
 * SQLite corruption watchdog.
 *
 * The daemon keeps all of its state — conversations, schedules, memory,
 * telemetry — in `bun:sqlite` files. When one of those files is damaged (a
 * torn write, a truncated file, bad disk media) SQLite surfaces it as a
 * `SQLITE_CORRUPT` / `SQLITE_NOTADB` error ("database disk image is malformed"
 * / "file is not a database") on the next statement that touches the damaged
 * page. Left unobserved, that damage is only noticed when a user hits a broken
 * feature; the platform has no fleet-wide view of how often it happens.
 *
 * This watchdog makes corruption observable. It emits a `watchdog` telemetry
 * event with `check_name = "sqlite_corrupted"` — the same stream the event-loop
 * watchdog uses — but POSTs it *directly* to the platform ingest rather than
 * through the SQLite-backed watchdog buffer: a check that fires because SQLite
 * is unusable must not depend on writing to SQLite, and going direct keeps this
 * module out of the `db-connection` import graph. The direct path still honors
 * the `share_analytics` opt-out (see {@link emitWatchdogEventDirect}). The
 * platform's already-merged `watchdog__sqlite_corruption_daily` admin query
 * filters `check_name` to this exact string, so it is the cross-repo contract
 * and must stay stable.
 *
 * Detection is per-statement: the shared slow-query wrapper — which already
 * wraps every `bun:sqlite` connection (main, logs, memory, telemetry — Drizzle
 * and raw) — hands every failed statement to {@link observeSqliteStatementError}.
 * So corruption is caught on *any* failing query or write, read or write, the
 * moment the workload actually hits the damaged page — no dedicated scan
 * needed. Non-corruption errors (constraint violations, syntax errors,
 * transient `SQLITE_BUSY`) are ignored.
 *
 * Reports are debounced per-database (a corrupt file throws on every
 * subsequent statement) — see {@link REPORT_COOLDOWN_MS}.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("sqlite-corruption-watchdog");

/**
 * Check name emitted for SQLite corruption events. The platform's
 * `watchdog__sqlite_corruption_daily` admin query filters `check_name` to
 * this exact string — it is the cross-repo contract, keep it stable.
 */
export const SQLITE_CORRUPTED_CHECK_NAME = "sqlite_corrupted";

/**
 * Minimum spacing between reports for a single database. Corruption is sticky:
 * once a file is malformed every subsequent statement against it throws the
 * same way, so without a cooldown a single damaged DB hit in a tight loop
 * would emit a flood of identical events. Keyed per database so damage to one
 * file never suppresses the first report for another.
 */
const REPORT_COOLDOWN_MS = 60_000;

const lastReportAtByDatabase = new Map<string, number>();

/** The most recent in-flight direct emit, so tests can await it. */
let pendingEmit: Promise<unknown> = Promise.resolve();

/**
 * Whether an error is SQLite reporting structural corruption — the
 * `SQLITE_CORRUPT` / `SQLITE_NOTADB` families, by extended result code or by
 * the canonical message text ("database disk image is malformed" / "file is
 * not a database"). Deliberately distinct from `isRetryableSqliteError`: a
 * corrupt image is permanent, not transient contention, so retrying can never
 * help. Pure, so callers (and tests) can classify a synthesized error without
 * a real database.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) {
    return true;
  }
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    message.includes("database disk image is malformed") ||
    message.includes("file is not a database")
  );
}

/**
 * Report a corruption detection: debounce per database and emit the
 * `sqlite_corrupted` telemetry event directly (opt-out gated inside
 * {@link emitWatchdogEventDirect}). The direct emit is lazy-imported so the
 * platform/telemetry stack only loads on the rare corruption path — and so this
 * module never pulls `db-connection` into its static import graph. Fire-and-
 * forget: the observer runs on a query hot path, so nothing here throws or
 * blocks on the POST.
 */
function reportCorruption(
  detail: Record<string, unknown> & { database: string },
): void {
  const now = Date.now();
  const last =
    lastReportAtByDatabase.get(detail.database) ?? Number.NEGATIVE_INFINITY;
  if (now - last < REPORT_COOLDOWN_MS) return;
  lastReportAtByDatabase.set(detail.database, now);

  log.error(detail, "SQLite corruption detected");

  pendingEmit = import("../telemetry/watchdog-direct-emit.js")
    .then(({ emitWatchdogEventDirect }) =>
      emitWatchdogEventDirect(SQLITE_CORRUPTED_CHECK_NAME, detail),
    )
    .catch(() => {
      // Best-effort; never let a telemetry failure escape the query path.
    });
}

/** Context handed to {@link observeSqliteStatementError} for a failed execution. */
export interface StatementErrorContext {
  /** SQL preview (truncated) of the failing statement. */
  sql: string;
  /**
   * The database file's basename (e.g. `"assistant.db"` / `"assistant-logs.db"`),
   * derived from the `Database`'s own `filename`. Always set by the wrapper;
   * optional only for direct callers (tests) that construct a context by hand.
   */
  database?: string;
  /** Caller-supplied `.label()` attribution tag, when present. */
  label?: string;
}

/**
 * Called by the slow-query wrapper for every failed statement: fires the
 * corruption event for `SQLITE_CORRUPT` / `SQLITE_NOTADB` errors and ignores
 * everything else (constraint/syntax errors, transient `SQLITE_BUSY` /
 * `SQLITE_IOERR` contention). The wrapper calls this directly, so there is no
 * observer registration or start/stop lifecycle — a corrupt file reports the
 * moment a statement hits it.
 */
export function observeSqliteStatementError(
  err: unknown,
  context: StatementErrorContext,
): void {
  if (!isSqliteCorruptionError(err)) return;
  reportCorruption({
    database: context.database ?? "unknown",
    error: err instanceof Error ? err.message : String(err),
    ...(context.sql ? { sql: context.sql } : {}),
    ...(context.label ? { label: context.label } : {}),
  });
}

/** Test-only: clear the per-database debounce state between cases. */
export function resetSqliteCorruptionWatchdogForTesting(): void {
  lastReportAtByDatabase.clear();
}

/** Test-only: await the most recent fire-and-forget direct emit. */
export function flushCorruptionEmitsForTesting(): Promise<unknown> {
  return pendingEmit;
}
