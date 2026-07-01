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
 * event with `check_name = "sqlite_corrupted"` — the same stream the
 * event-loop watchdog uses — flowing through the same {@link recordWatchdogEvent}
 * helper, batching, retry, and `collectUsageData` opt-out gating. The
 * platform's already-merged `watchdog__sqlite_corruption_daily` admin query
 * filters `check_name` to this exact string, so it is the cross-repo contract
 * and must stay stable.
 *
 * Detection is per-statement, not polled: {@link observeSqliteStatementError}
 * is registered as the {@link setStatementErrorObserver} hook on the shared
 * slow-query wrapper that already wraps every `bun:sqlite` connection (main,
 * logs, memory, telemetry — Drizzle and raw). So corruption is caught on *any*
 * failing query or write, read or write, the moment the workload actually hits
 * it — with no `PRAGMA integrity_check` loop that would itself block the event
 * loop for minutes on a multi-GB file. Non-corruption errors (constraint
 * violations, syntax errors, transient `SQLITE_BUSY`) are ignored.
 *
 * Reports are debounced per-database (a corrupt file throws on every
 * subsequent statement) — see {@link REPORT_COOLDOWN_MS}.
 */

import * as Sentry from "@sentry/node";

import type { StatementErrorContext } from "../persistence/slow-query-log.js";
import { setStatementErrorObserver } from "../persistence/slow-query-log.js";
import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
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
 * Emit a `sqlite_corrupted` watchdog telemetry event, debounced per database.
 * `recordWatchdogEvent` no-ops when usage-data collection is disabled (the
 * event is dropped to honor the opt-out), so this runs unconditionally without
 * leaking health data for opted-out owners. Telemetry/Sentry failures are
 * swallowed — corruption reporting must never itself throw into a query path.
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
  try {
    recordWatchdogEvent({ checkName: SQLITE_CORRUPTED_CHECK_NAME, detail });
  } catch {
    // Never let a telemetry failure escape into the calling query path.
  }
  try {
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("sqlite_corruption_database", detail.database);
      scope.setContext("sqlite_corruption", detail);
      Sentry.captureMessage(SQLITE_CORRUPTED_CHECK_NAME);
    });
  } catch {
    // Never let a telemetry failure escape into the calling query path.
  }
}

/**
 * Observer registered on the shared slow-query wrapper. Fires the corruption
 * event for `SQLITE_CORRUPT` / `SQLITE_NOTADB` errors thrown by any statement
 * and ignores everything else (constraint/syntax errors, transient
 * `SQLITE_BUSY` / `SQLITE_IOERR` contention).
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

/**
 * Start the corruption watchdog: register the statement-error observer on the
 * shared SQLite wrapper. Idempotent — safe to call unconditionally at daemon
 * boot, and connections wrapped before this runs still report later failures.
 */
export function startSqliteCorruptionWatchdog(): void {
  setStatementErrorObserver(observeSqliteStatementError);
  log.info("SQLite corruption watchdog started");
}

/** Stop the watchdog: unregister the observer. Safe to call any number of times. */
export function stopSqliteCorruptionWatchdog(): void {
  setStatementErrorObserver(null);
}

/** Test-only: clear the per-database debounce state between cases. */
export function resetSqliteCorruptionWatchdogForTesting(): void {
  lastReportAtByDatabase.clear();
}
