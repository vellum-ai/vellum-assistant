/**
 * Periodic database integrity sample, reported as a `db_integrity` watchdog
 * event so the platform can read corruption prevalence across the fleet.
 *
 * The `PRAGMA quick_check` itself runs in a short-lived subprocess
 * (`db-integrity-check.ts`) — bun:sqlite's page walk is synchronous, and a
 * multi-second scan inside this process would stall the resource sampler and
 * signal handling, the exact things the monitor exists to keep responsive.
 * The check opens a read-only handle and never mutates the database.
 *
 * At most one sample per 24h per install (stamped on disk), so the
 * denominator is "installs that reported today" rather than "daemon
 * restarts". The stamp is written only after the event is queued: a failed
 * enqueue leaves the install due, so it retries next poll instead of
 * silently dropping out of the day's denominator.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getRawShareAnalytics } from "../platform/consent-cache.js";
import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import { getLogger } from "../util/logger.js";
import { getDbPath, getMonitoringDataDir } from "../util/platform.js";
import type { IntegritySampleResult } from "./db-integrity-check.js";

const log = getLogger("db-integrity-sample");

/** Watchdog `check_name` carrying the quick_check outcome. */
const CHECK_NAME = "db_integrity";

/** Minimum spacing between samples on one install. */
const SAMPLE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How often the sampler re-tests the 24h stamp (covers long-uptime installs). */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Delay before the first attempt, keeping the scan off the boot I/O path. */
const BOOT_DELAY_MS = 60_000;

/** Kill switch for a check subprocess wedged on pathological I/O. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

const STAMP_FILENAME = "db-integrity-last-run-at";

/**
 * Run the quick_check probe in a subprocess and parse its JSON verdict.
 * Returns null — "no sample" — on a non-zero exit, unparseable output, or
 * timeout (the child is killed).
 */
/**
 * The in-flight check subprocess, retained so sampler shutdown can kill it —
 * a non-detached child survives the monitor's exit and would otherwise hold
 * its SQLite read snapshot for up to CHECK_TIMEOUT_MS while the daemon
 * restarts.
 */
let activeChild: ReturnType<typeof Bun.spawn> | null = null;

async function runCheckSubprocess(
  dbPath: string,
): Promise<IntegritySampleResult | null> {
  // `fileURLToPath`, not `.pathname`: the latter percent-encodes, and an
  // install path with a space in it would not resolve. See worker-process.ts.
  const entry = fileURLToPath(
    new URL("./db-integrity-check.ts", import.meta.url),
  );
  const child = Bun.spawn({
    cmd: ["bun", "--smol", "run", entry, dbPath],
    stdio: ["ignore", "pipe", "ignore"],
  });
  activeChild = child;
  const killTimer = setTimeout(() => child.kill(), CHECK_TIMEOUT_MS);
  killTimer.unref?.();
  try {
    const stdout = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) {
      return null;
    }
    return JSON.parse(stdout) as IntegritySampleResult | null;
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
    activeChild = null;
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
 * event. Never throws. Skips entirely on a confirmed analytics opt-out,
 * where the event would be dropped at record time anyway and the scan would
 * be pure wasted I/O.
 */
export async function sampleDbIntegrityIfDue(): Promise<void> {
  if (getRawShareAnalytics() === false || !due()) {
    return;
  }
  try {
    if (!existsSync(getDbPath())) {
      return; // no database yet — stay due, retry next poll
    }
    const result = await runCheckSubprocess(getDbPath());
    if (!result) {
      return; // locked, operational failure, or timeout — stay due
    }
    const queued = recordWatchdogEvent({
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
    if (queued) {
      writeFileSync(stampPath(), "");
    }
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
  bootTimer = setTimeout(() => void sampleDbIntegrityIfDue(), BOOT_DELAY_MS);
  bootTimer.unref?.();
  pollTimer = setInterval(
    () => void sampleDbIntegrityIfDue(),
    POLL_INTERVAL_MS,
  );
  pollTimer.unref?.();
}

/** Stop the sampler loop and any in-flight check subprocess. Idempotent. */
export function stopDbIntegritySampler(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  activeChild?.kill();
  activeChild = null;
}
