/**
 * Event-loop block watchdog.
 *
 * The daemon runs all request handling, synchronous `bun:sqlite` access, and
 * background jobs on a single event-loop thread. Any synchronous operation that
 * runs long — a large conversation-history load, a memory retrospective
 * assembling an oversized conversation, a VACUUM or WAL checkpoint — blocks that
 * thread, so the daemon stops answering health probes and SSE for the duration
 * (a proxied `vellum ps` health check then reports `timeout` even though the
 * process is alive). Such a freeze is otherwise invisible: the blocked thread is
 * too busy to emit logs, so it leaves only a gap that self-heals when the
 * operation returns, and is noticed only by chance.
 *
 * This watchdog makes those freezes observable. It schedules a timer every
 * `TICK_INTERVAL_MS`; when the loop is blocked the callback cannot run, so it
 * fires late by roughly the block duration. On the first tick after the loop
 * frees up, the elapsed-since-last-tick beyond a normal interval is how long the
 * loop was unavailable; above a threshold it emits a warn log + Sentry capture.
 *
 * What it does NOT do: capture the JS stack of the blocking operation. JS is
 * single-threaded, so while the loop is blocked no callback — including this one
 * — can run; by the time the tick fires, the offending synchronous call has
 * returned and its stack is gone. Instead, each freeze report carries the
 * section trail (`persistence/slow-sync-log.ts`): the recent instrumented
 * sections with their start/end ages relative to the report. The newest entry
 * older than `blockedMs` that hadn't ended when the block began names — or
 * brackets — the code that froze. For sub-threshold contributors, time the
 * subsystem's synchronous calls at their source with `timeSyncSection`.
 *
 * Kernel-side stall classification is owned by the resource monitor process,
 * not this watchdog — nothing here reads sysfs or /proc. Each tick touches a
 * heartbeat file (one mtime update; because the touch runs on the loop, a
 * stale heartbeat *is* a blocked loop). The monitor watches that heartbeat
 * from its own OS process and, mid-stall, captures the daemon main thread's
 * kernel stack and process state alongside its regular memory.stat / reclaim /
 * cpu.stat sample deltas (`monitoring/stall-capture.ts`). When this watchdog
 * fires on unblock, the report attaches the monitor's capture for the window —
 * classifying freezes that are not JS at all (synchronous kernel reclaim,
 * CPU-quota throttling, lock waits). When monitoring is disabled the report
 * degrades to blockedMs + section trail.
 *
 * A cumulative event-loop-delay histogram is separately exposed pull-based over
 * SSE diagnostics (`runtime/routes/events-routes.ts`); this watchdog is the
 * push/alert counterpart and runs unconditionally for the daemon's lifetime.
 */

import * as Sentry from "@sentry/node";

import { touchDaemonHeartbeat } from "../monitoring/daemon-heartbeat.js";
import {
  findRecentStallCapture,
  type StallCapture,
} from "../monitoring/stall-capture.js";
import {
  getSectionTrail,
  type SectionTrailEntry,
} from "../persistence/slow-sync-log.js";
import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("event-loop-watchdog");

/** How often the probe timer is scheduled. */
const TICK_INTERVAL_MS = 1_000;

/**
 * Report only when the loop was unavailable for at least this long beyond a
 * normal tick. Set above the floor of the daemon's known-legitimate
 * multi-second main-thread operations so the signal stays actionable rather than
 * noisy; tune here.
 */
const DEFAULT_BLOCK_THRESHOLD_MS = 5_000;

/**
 * Minimum spacing between reports. A single long freeze fires the timer once on
 * unblock (an overdue interval is not replayed per missed tick), but a loop that
 * blocks repeatedly could trip every tick; the cooldown bounds that to one
 * report per window.
 */
const REPORT_COOLDOWN_MS = 30_000;

/**
 * How far before the computed block start a monitor stall capture may be
 * timestamped and still be attached to the report. Absorbs the skew between
 * the heartbeat mtime, the monitor's sampling cadence, and this process's
 * clock.
 */
const STALL_CAPTURE_MATCH_GRACE_MS = 5_000;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
let lastReportAt = Number.NEGATIVE_INFINITY;

/**
 * Given the wall-clock elapsed since the previous tick and the scheduled tick
 * interval, the loop was blocked for the excess over the interval. Pure so the
 * threshold decision is unit-testable without real timers or a blocked loop.
 */
export function evaluateTick(
  elapsedMs: number,
  intervalMs: number,
  thresholdMs: number,
): { blockedMs: number; exceeded: boolean } {
  const blockedMs = Math.max(0, elapsedMs - intervalMs);
  return { blockedMs, exceeded: blockedMs >= thresholdMs };
}

/**
 * Check name emitted for event-loop block events. The platform's
 * `watchdog__event_loop_blocking_daily` admin query filters `check_name` to
 * this exact string, so it is the primary group-by dimension downstream —
 * keep it stable.
 */
export const EVENT_LOOP_BLOCKED_CHECK_NAME = "event_loop_blocked";

async function reportBlock(
  blockedMs: number,
  thresholdMs: number,
): Promise<void> {
  // Attribution breadcrumbs: the block began ~`blockedMs` before this report,
  // so the newest trail entry started at least that long ago — and not yet
  // ended by then — is the section that was running when the loop froze.
  let sectionTrail: SectionTrailEntry[] = [];
  try {
    sectionTrail = getSectionTrail();
  } catch {
    // Diagnostics-only — never let it escape the timer callback.
  }
  // The resource monitor's mid-stall capture of this block, if it took one:
  // the monitor detects the stale heartbeat within its 250ms sampling cadence,
  // so a capture for a threshold-length block exists before this report fires.
  // The grace ahead of the block start absorbs heartbeat-vs-clock skew. Async
  // read — the report path must not add synchronous I/O to the loop.
  let stallCapture: StallCapture | null = null;
  try {
    stallCapture = await findRecentStallCapture(
      Date.now() - blockedMs - STALL_CAPTURE_MATCH_GRACE_MS,
    );
  } catch {
    // Diagnostics-only — never let it escape the timer callback.
  }
  log.warn(
    {
      blockedMs,
      thresholdMs,
      tickIntervalMs: TICK_INTERVAL_MS,
      sectionTrail,
      stallCapture,
    },
    "event loop blocked",
  );
  // Persist a `watchdog` telemetry event so the platform can surface
  // event-loop blocking in the infrastructure admin chart. `recordWatchdogEvent`
  // no-ops when usage-data collection is disabled (the event is dropped to
  // honor the opt-out), so the watchdog runs unconditionally without leaking
  // health data for opted-out owners. Never let a telemetry failure escape
  // the timer callback — wrap it alongside the Sentry capture below.
  try {
    recordWatchdogEvent({
      checkName: EVENT_LOOP_BLOCKED_CHECK_NAME,
      value: blockedMs,
      detail: {
        threshold_ms: thresholdMs,
        tick_interval_ms: TICK_INTERVAL_MS,
        section_trail: sectionTrail,
        stall_capture: stallCapture,
      },
    });
  } catch {
    // Never let a telemetry failure escape the timer callback.
  }
  try {
    Sentry.withScope((scope) => {
      scope.setLevel("warning");
      scope.setTag("event_loop_blocked_ms", String(blockedMs));
      scope.setContext("event_loop_block", {
        blocked_ms: blockedMs,
        threshold_ms: thresholdMs,
        tick_interval_ms: TICK_INTERVAL_MS,
        section_trail: sectionTrail,
        stall_capture: stallCapture,
      });
      Sentry.captureMessage(EVENT_LOOP_BLOCKED_CHECK_NAME);
    });
  } catch {
    // Never let a telemetry failure escape the timer callback.
  }
}

/**
 * Start the event-loop block watchdog. Idempotent. The timer is `unref`'d so it
 * never keeps the process alive on its own.
 */
export function startEventLoopWatchdog(
  thresholdMs: number = DEFAULT_BLOCK_THRESHOLD_MS,
): void {
  if (tickTimer) {
    return;
  }
  lastTickAt = performance.now();
  lastReportAt = Number.NEGATIVE_INFINITY;
  tickTimer = setInterval(() => {
    const now = performance.now();
    const { blockedMs, exceeded } = evaluateTick(
      now - lastTickAt,
      TICK_INTERVAL_MS,
      thresholdMs,
    );
    lastTickAt = now;
    // One mtime touch per tick — the resource monitor reads its staleness to
    // detect (and capture) a blocked loop while the stall is in progress.
    touchDaemonHeartbeat();
    if (exceeded && now - lastReportAt >= REPORT_COOLDOWN_MS) {
      lastReportAt = now;
      void reportBlock(blockedMs, thresholdMs).catch(() => {
        // Diagnostics-only — never let it escape the timer callback.
      });
    }
  }, TICK_INTERVAL_MS);
  tickTimer.unref?.();
  log.info(
    { tickIntervalMs: TICK_INTERVAL_MS, thresholdMs },
    "Event-loop watchdog started",
  );
}

export function stopEventLoopWatchdog(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
