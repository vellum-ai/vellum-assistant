/**
 * Periodic `PRAGMA quick_check` sample on the daemon's database, reported as a
 * `db_integrity` watchdog event so the platform can read corruption prevalence
 * across the fleet.
 *
 * Runs in the monitor process, off the daemon's event loop, on a read-only
 * handle — the check never mutates the database. At most one sample per 24h
 * per install (stamped on disk), so the denominator is "installs that reported
 * today" rather than "daemon restarts".
 *
 * We use `quick_check` rather than the full `integrity_check` the `assistant db
 * repair` step runs: quick_check skips the index ↔ table cross-verification,
 * which is the expensive half on a multi-GB database, while still walking every
 * page and catching the b-tree damage that makes a database unusable. A
 * background sweep nobody asked for has to stay cheap.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import { getLogger } from "../util/logger.js";
import { getDbPath, getMonitoringDataDir } from "../util/platform.js";

const log = getLogger("db-integrity-sample");

/** Watchdog `check_name` carrying the quick_check outcome. */
const CHECK_NAME = "db_integrity";

/** Minimum spacing between samples on one install. */
const SAMPLE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How often the sampler re-tests the 24h stamp (covers long-uptime installs). */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delay before the first attempt, keeping the scan off the boot I/O path. */
const BOOT_DELAY_MS = 60_000;

/** Cap on quick_check error rows — a wrecked DB reports thousands. */
const MAX_ERRORS = 10;

const STAMP_FILENAME = "db-integrity-last-run-at";

export interface IntegritySampleResult {
  ok: boolean;
  errors: string[];
  pageCount: number;
  durationMs: number;
}

/**
 * Lock contention with the daemon (checkpoint restarts, WAL recovery) is not
 * corruption — mapping it to `ok: false` would inflate the very prevalence
 * number this sampler exists to measure. Busy maps to "no sample" instead.
 */
function isBusy(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/**
 * Run `PRAGMA quick_check` against `dbPath` on a read-only handle.
 *
 * A database SQLite refuses to open, and a check that throws part-way
 * ("database disk image is malformed"), are both corruption signals, not
 * failures of this function — they come back as `ok: false` with the error
 * message. Returns null when the file does not exist yet or the database is
 * locked past the busy timeout; both mean "no sample", so the caller stays
 * due and retries next poll.
 */
export function runIntegrityCheck(
  dbPath: string,
): IntegritySampleResult | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  const startedAt = Date.now();
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    if (isBusy(err)) {
      return null;
    }
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      pageCount: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const rows = db
      .query<{ quick_check: string }, []>(`PRAGMA quick_check(${MAX_ERRORS})`)
      .all();
    const messages = rows.map((r) => r.quick_check);
    return {
      ok: messages.length === 1 && messages[0] === "ok",
      errors: messages.length === 1 && messages[0] === "ok" ? [] : messages,
      pageCount: pageCount(db),
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (isBusy(err)) {
      return null;
    }
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      pageCount: pageCount(db),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    db.close();
  }
}

function pageCount(db: Database): number {
  try {
    return (
      db.query<{ page_count: number }, []>("PRAGMA page_count").get()
        ?.page_count ?? 0
    );
  } catch {
    return 0;
  }
}

function stampPath(): string {
  return join(getMonitoringDataDir(), STAMP_FILENAME);
}

function due(): boolean {
  try {
    return Date.now() - statSync(stampPath()).mtimeMs >= SAMPLE_INTERVAL_MS;
  } catch {
    return true; // never sampled (or unreadable stamp) — sample now
  }
}

/**
 * Sample once if the install is due, emitting one `db_integrity` watchdog
 * event. Never throws. Skips entirely on a confirmed analytics opt-out, where
 * the event would be dropped at record time anyway and the scan would be pure
 * wasted I/O.
 */
export function sampleDbIntegrityIfDue(): void {
  if (getRawShareAnalytics() === false || !due()) {
    return;
  }
  try {
    const result = runIntegrityCheck(getDbPath());
    if (!result) {
      return; // no database yet — stay due, retry next poll
    }
    writeFileSync(stampPath(), "");
    recordWatchdogEvent({
      checkName: CHECK_NAME,
      value: result.errors.length,
      detail: {
        ok: result.ok,
        mode: "quick_check",
        page_count: result.pageCount,
        duration_ms: result.durationMs,
        errors: result.errors,
      },
    });
    if (!result.ok) {
      log.warn(
        { errors: result.errors, pageCount: result.pageCount },
        "Database integrity sample reported corruption",
      );
    }
  } catch (err) {
    log.warn({ err }, "Database integrity sample failed (non-fatal)");
  }
}

let bootTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the integrity sampler in the monitor process. No-op in dev mode
 * (VELLUM_DEV=1) and idempotent if already started.
 */
export function startDbIntegritySampler(): void {
  if (process.env.VELLUM_DEV === "1" || pollTimer) {
    return;
  }
  bootTimer = setTimeout(sampleDbIntegrityIfDue, BOOT_DELAY_MS);
  bootTimer.unref?.();
  pollTimer = setInterval(sampleDbIntegrityIfDue, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

/** Stop the sampler loop. Idempotent. */
export function stopDbIntegritySampler(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
