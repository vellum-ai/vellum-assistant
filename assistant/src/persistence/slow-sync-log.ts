/**
 * Attribution for event-loop stalls caused by synchronous SQLite work.
 *
 * `bun:sqlite` runs on the daemon's single event-loop thread, so any slow
 * statement — a large conversation-history load, a memory scan, a WAL
 * checkpoint folding a multi-GB WAL — freezes every other handler (SSE,
 * HTTP, health) for its full duration. The event-loop watchdog
 * (`daemon/event-loop-watchdog.ts`) detects *that* a freeze happened but,
 * being single-threaded itself, cannot capture *what* was running: by the
 * time its tick fires the blocking call has returned and its stack is gone.
 *
 * This module fills that gap. Wrap a known-heavy synchronous section with
 * {@link timeSyncSection} (or call {@link reportSlowSync} with a measured
 * duration); when it blocks past {@link SLOW_SYNC_THRESHOLD_MS} it logs a
 * structured warning naming the call site and records a `watchdog`
 * telemetry event, so the next freeze is attributable to a specific
 * operation instead of an anonymous gap in the logs.
 *
 * The threshold is deliberately below the watchdog's own 5s floor so
 * sub-watchdog contributors are still named. Override with
 * `VELLUM_SLOW_SYNC_THRESHOLD_MS`.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("slow-sync");

/**
 * Synchronous sections that block the event loop at least this long are
 * reported. Env-overridable for tuning attribution verbosity on a busy
 * host without a rebuild; falls back to 1000ms for any non-positive or
 * unparseable value.
 */
export const SLOW_SYNC_THRESHOLD_MS = ((): number => {
  const raw = Number(process.env.VELLUM_SLOW_SYNC_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
})();

/**
 * `check_name` for slow-sync telemetry events. Stable so downstream
 * grouping stays consistent; keep it in sync with any admin query.
 */
export const SLOW_SYNC_CHECK_NAME = "slow_sync_operation";

/**
 * Report a synchronous section that blocked the event loop for `elapsedMs`.
 * No-op below {@link SLOW_SYNC_THRESHOLD_MS}. `label` names the call site
 * (e.g. `conversation:load-from-db`); `detail` carries attribution context
 * (conversation id, row count, SQL preview) — never conversation content.
 */
export function reportSlowSync(
  label: string,
  elapsedMs: number,
  detail?: Record<string, unknown>,
): void {
  if (elapsedMs < SLOW_SYNC_THRESHOLD_MS) return;
  log.warn(
    { label, elapsedMs, ...detail },
    "Slow synchronous DB operation blocked the event loop",
  );
  // Record telemetry via a lazy dynamic import. A static import would pull the
  // telemetry → consent-cache → config/loader chain into the module graph of
  // every raw-query / conversation-load caller, where a test's `mock.module`
  // of the loader leaks across the shared test process and breaks unrelated
  // files at eval time. Loading it only on the rare slow path keeps that chain
  // off the hot path's static graph; best-effort, so a failure is swallowed.
  void import("../telemetry/watchdog-events-store.js")
    .then(({ recordWatchdogEvent }) => {
      recordWatchdogEvent({
        checkName: SLOW_SYNC_CHECK_NAME,
        value: elapsedMs,
        detail: { label, ...detail },
      });
    })
    .catch(() => {
      // Telemetry is best-effort — never let it escape the timed section.
    });
}

/**
 * Time a synchronous section, returning its value, and {@link reportSlowSync}
 * it when it blocks past the threshold. `detail` is evaluated only on
 * success, from the section's result, so it can report a computed count.
 * A thrown error is still reported (the failed op still blocked) and then
 * rethrown unchanged.
 */
export function timeSyncSection<T>(
  label: string,
  fn: () => T,
  detail?: (result: T) => Record<string, unknown>,
): T {
  const start = performance.now();
  try {
    const result = fn();
    const elapsedMs = performance.now() - start;
    // Build `detail` only when actually reporting — the section runs on hot
    // query paths, so the thunk must not allocate on the sub-threshold path.
    if (elapsedMs >= SLOW_SYNC_THRESHOLD_MS) {
      reportSlowSync(label, elapsedMs, detail?.(result));
    }
    return result;
  } catch (err) {
    reportSlowSync(label, performance.now() - start);
    throw err;
  }
}
