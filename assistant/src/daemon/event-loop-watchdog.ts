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
 * loop was unavailable; above a threshold it emits a warn log + telemetry event.
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

import { touchDaemonHeartbeat } from "../monitoring/daemon-heartbeat.js";
import {
  findRecentStallCapture,
  type StallCapture,
} from "../monitoring/stall-capture.js";
import {
  getSectionTrail,
  type SectionTrailEntry,
} from "../persistence/slow-sync-log.js";
import { watchdogTelemetryEventSchema } from "../telemetry/telemetry-wire.generated.js";
import { recordWatchdogEvent } from "../telemetry/watchdog-events-store.js";
import { getLogger } from "../util/logger.js";
import {
  type DaemonActivityGroup,
  getActivityOverlapping,
} from "./activity-trail.js";

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

/**
 * Whether ingest accepts `detail`, judged by the generated wire contract so
 * the byte measurement matches the server's exactly. The detail is checked
 * as serialized (undefined keys dropped, as on the wire). The other event
 * fields are fixed valid values; only issues on `detail` count.
 */
export function detailFitsServerCap(detail: object): boolean {
  const result = watchdogTelemetryEventSchema.safeParse({
    type: "watchdog",
    daemon_event_id: "size-check",
    recorded_at: 0,
    check_name: EVENT_LOOP_BLOCKED_CHECK_NAME,
    detail: JSON.parse(JSON.stringify(detail)),
  });
  return (
    result.success || !result.error.issues.some((i) => i.path[0] === "detail")
  );
}

type BlockTelemetryDetail = {
  threshold_ms: number;
  tick_interval_ms: number;
  /** Process uptime at report time; small values mean boot work. */
  daemon_uptime_ms: number;
  /** Work on this process that overlapped the block, grouped by label. */
  activity: DaemonActivityGroup[];
  section_trail: SectionTrailEntry[];
  stall_capture: StallCapture | null;
  /** Trim steps applied to fit the byte cap, in order. Absent when none. */
  trimmed?: string[];
};

/**
 * Ordered steps that shrink an oversize report, least diagnostic loss first.
 * The activity groups, the busiest processes, the newest section-trail
 * entries, and the capture's wait state are what attribute a block, so they
 * go last.
 */
const TRIM_STEPS: Array<{
  name: string;
  apply: (detail: BlockTelemetryDetail) => void;
}> = [
  {
    name: "section_trail_8",
    apply: (d) => {
      d.section_trail = d.section_trail.slice(0, 8);
    },
  },
  {
    name: "thread_groups",
    apply: (d) => {
      if (d.stall_capture?.waitState) {
        d.stall_capture.waitState.threads = [];
      }
    },
  },
  {
    name: "active_conversations",
    apply: (d) => {
      if (d.stall_capture) {
        d.stall_capture.sample.activeConversations = null;
      }
    },
  },
  {
    name: "memory_stat",
    apply: (d) => {
      if (d.stall_capture) {
        d.stall_capture.sample.memoryStat = null;
      }
    },
  },
  {
    name: "kernel_stack_512",
    apply: (d) => {
      if (d.stall_capture?.kernelStack) {
        d.stall_capture.kernelStack = d.stall_capture.kernelStack.slice(0, 512);
      }
    },
  },
  {
    name: "section_trail_3",
    apply: (d) => {
      d.section_trail = d.section_trail.slice(0, 3);
    },
  },
  {
    // Keeps the daemon, which the sampler always lists last, for comparison.
    name: "processes_3",
    apply: (d) => {
      const processes = d.stall_capture?.sample.processes;
      if (processes) {
        const daemon = processes.find((p) => p.name === "daemon");
        const kept = processes.slice(0, 3);
        d.stall_capture!.sample.processes =
          daemon && !kept.includes(daemon) ? [...kept, daemon] : kept;
      }
    },
  },
  {
    name: "activity_4",
    apply: (d) => {
      d.activity = d.activity.slice(0, 4);
    },
  },
  {
    // Last resort so the report itself always lands: blockedMs and the
    // longest activity groups survive.
    name: "stall_capture",
    apply: (d) => {
      d.stall_capture = null;
      d.section_trail = [];
    },
  },
];

/**
 * The telemetry `detail` for a block report. Conversation titles are dropped
 * (the event is metadata only and titles can carry user content), then trim
 * steps apply until the bag fits the server's byte cap. An oversize bag is
 * rejected outright, losing the whole report. Pure so the budget
 * logic is unit-testable.
 */
export function buildBlockTelemetryDetail(input: {
  thresholdMs: number;
  daemonUptimeMs: number;
  activity: DaemonActivityGroup[];
  sectionTrail: SectionTrailEntry[];
  stallCapture: StallCapture | null;
}): BlockTelemetryDetail {
  // Deep copy: the trim steps mutate, and the caller's objects also feed the log.
  const stallCapture: StallCapture | null = input.stallCapture
    ? structuredClone(input.stallCapture)
    : null;
  if (stallCapture?.sample.activeConversations) {
    stallCapture.sample.activeConversations =
      stallCapture.sample.activeConversations.map((conversation) => ({
        ...conversation,
        title: null,
      }));
  }
  const detail: BlockTelemetryDetail = {
    threshold_ms: input.thresholdMs,
    tick_interval_ms: TICK_INTERVAL_MS,
    daemon_uptime_ms: input.daemonUptimeMs,
    activity: [...input.activity],
    section_trail: [...input.sectionTrail],
    stall_capture: stallCapture,
  };

  for (const step of TRIM_STEPS) {
    if (detailFitsServerCap(detail)) {
      break;
    }
    step.apply(detail);
    // Assigned before the next measurement so the marker counts too.
    detail.trimmed = [...(detail.trimmed ?? []), step.name];
  }
  return detail;
}

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
  // Work that overlapped the block window. Read before the first await so
  // work that starts after the loop frees up is not attributed to the block.
  let activity: DaemonActivityGroup[] = [];
  try {
    activity = getActivityOverlapping(blockedMs + TICK_INTERVAL_MS);
  } catch {
    // Diagnostics-only; never let it escape the timer callback.
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
      activity,
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
  // the timer callback.
  try {
    recordWatchdogEvent({
      checkName: EVENT_LOOP_BLOCKED_CHECK_NAME,
      value: blockedMs,
      detail: buildBlockTelemetryDetail({
        thresholdMs,
        daemonUptimeMs: Math.round(process.uptime() * 1000),
        activity,
        sectionTrail,
        stallCapture,
      }),
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
