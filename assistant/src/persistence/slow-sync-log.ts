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
 * This module fills that gap two ways:
 *
 * 1. **Threshold reports** — wrap a known-heavy synchronous section with
 *    {@link timeSyncSection} (or call {@link reportSlowSync} with a measured
 *    duration); when it blocks past {@link SLOW_SYNC_THRESHOLD_MS} it logs a
 *    structured warning naming the call site and records a `watchdog`
 *    telemetry event. The threshold is deliberately below the watchdog's own
 *    5s floor so sub-watchdog contributors are still named. Override with
 *    `VELLUM_SLOW_SYNC_THRESHOLD_MS`.
 *
 * 2. **Section trail** — a small in-memory ring of the most recently entered
 *    instrumented sections ({@link markSection} / {@link traceAsyncSection};
 *    {@link timeSyncSection} marks automatically). The event-loop watchdog
 *    attaches {@link getSectionTrail} to every freeze report: because the
 *    loop is single-threaded, the newest mark still un-ended at block start
 *    (entries older than `blockedMs`) names — or tightly brackets — the code
 *    that froze, even when the block sits in a section nobody thought to
 *    time. Marks record only static labels, never content.
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

/** One recorded section entry: a static label plus monotonic start/end stamps. */
export interface SectionMark {
  label: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * How many section marks the trail retains. Sized so the sections between a
 * container mark (e.g. an agent-event dispatch) and a freeze — typically a
 * handful of nested query marks — don't evict the container before the
 * watchdog reads the trail.
 */
const SECTION_TRAIL_CAPACITY = 16;

const sectionTrail: SectionMark[] = [];

/**
 * Record that an instrumented section is starting. Returns the mark so the
 * caller can stamp its completion with {@link endSection}. Cheap enough for
 * hot paths: one small allocation and a bounded-array push.
 */
export function markSection(label: string): SectionMark {
  const mark: SectionMark = { label, startedAt: performance.now() };
  sectionTrail.push(mark);
  if (sectionTrail.length > SECTION_TRAIL_CAPACITY) {
    sectionTrail.shift();
  }
  return mark;
}

/** Stamp a mark's completion; returns the section's elapsed milliseconds. */
export function endSection(mark: SectionMark): number {
  mark.endedAt = performance.now();
  return mark.endedAt - mark.startedAt;
}

/**
 * Trail a section that spans an `await` (a hook chain, a provider call). The
 * mark stays open for the span's full wall time — sections entered by work
 * interleaving on the loop during the await appear as newer trail entries, so
 * a freeze inside the span is still bracketed correctly. Wall time is NOT
 * reported as a slow sync: an awaited span legitimately spends most of it
 * off-loop.
 */
export async function traceAsyncSection<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const mark = markSection(label);
  try {
    return await fn();
  } finally {
    endSection(mark);
  }
}

/** A trail entry made relative to "now" for freeze reports. */
export interface SectionTrailEntry {
  label: string;
  startedAgoMs: number;
  /** Absent while the section is still running (or never ended). */
  endedAgoMs?: number;
}

/**
 * Newest-first snapshot of recent section marks, ages relative to `now`.
 * Reading it against a freeze report: the block began ~`blockedMs` ago, so
 * the newest entry with `startedAgoMs >= blockedMs` that has no `endedAgoMs`
 * (or ended after the block began) is the section that was running when the
 * loop froze.
 */
export function getSectionTrail(
  now: number = performance.now(),
): SectionTrailEntry[] {
  return [...sectionTrail].reverse().map((mark) => ({
    label: mark.label,
    startedAgoMs: Math.round(now - mark.startedAt),
    ...(mark.endedAt !== undefined
      ? { endedAgoMs: Math.round(now - mark.endedAt) }
      : {}),
  }));
}

/** Test isolation only — the trail is process-global module state. */
export function resetSectionTrailForTests(): void {
  sectionTrail.length = 0;
}

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
 * it when it blocks past the threshold. Every section also lands in the
 * section trail, so watchdog freeze reports can place it on the timeline.
 * `detail` is evaluated only on success, from the section's result, so it can
 * report a computed count. A thrown error is still reported (the failed op
 * still blocked) and then rethrown unchanged.
 */
export function timeSyncSection<T>(
  label: string,
  fn: () => T,
  detail?: (result: T) => Record<string, unknown>,
): T {
  const mark = markSection(label);
  try {
    const result = fn();
    const elapsedMs = endSection(mark);
    // Build `detail` only when actually reporting — the section runs on hot
    // query paths, so the thunk must not allocate on the sub-threshold path.
    if (elapsedMs >= SLOW_SYNC_THRESHOLD_MS) {
      reportSlowSync(label, elapsedMs, detail?.(result));
    }
    return result;
  } catch (err) {
    reportSlowSync(label, endSection(mark));
    throw err;
  }
}
