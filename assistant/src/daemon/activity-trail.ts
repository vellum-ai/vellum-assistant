/**
 * Recent work this process ran, so an event-loop block report can say what
 * was running while the loop was blocked.
 *
 * The section trail (`persistence/slow-sync-log.ts`) names instrumented
 * synchronous sections, which cover a small share of blocks. This trail
 * records coarse units of work instead: every agent turn, labelled by
 * conversation type, call site, and origin interface, plus the non-turn
 * background jobs that run on the daemon (the scheduler tick, bundle export
 * and import, the channel retry sweep, git history compaction, memory
 * startup). A block report groups the entries that overlap its window, which
 * answers whether background work shared the loop with a user-facing turn.
 *
 * Labels are closed sets (no free-form strings), so the grouped result is
 * safe to send as telemetry. The trail is per process; only the daemon
 * reports it.
 */

import type { InterfaceId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";

export type DaemonActivityKind =
  | "turn"
  | "schedule_tick"
  | "vbundle_export"
  | "vbundle_import"
  | "channel_retry_sweep"
  | "git_compaction"
  | "memory_startup";

/** Conversation types a turn label carries; anything else is "other". */
const TURN_CONVERSATION_TYPES = new Set([
  "standard",
  "background",
  "scheduled",
]);

export interface DaemonActivityLabel {
  kind: DaemonActivityKind;
  /** Turns only: the conversation's type. */
  conversationType?: "standard" | "background" | "scheduled" | "other";
  /** Turns only: the LLM call site the turn runs under. */
  callSite?: LLMCallSite;
  /** Turns only: the interface the conversation came from, if any. */
  originInterface?: InterfaceId;
  /** Turns only: whether a client is attached and waiting on the reply. */
  interactive?: boolean;
}

export interface DaemonActivityGroup extends DaemonActivityLabel {
  /** Entries with this label that overlapped the window. */
  count: number;
  /** Of those, how many were still running at report time. */
  running: number;
  /** Longest single entry, clamped to the report time for running ones. */
  longestMs: number;
}

interface ActivityMark {
  label: DaemonActivityLabel;
  startedAt: number;
  endedAt?: number;
}

/** Ended entries kept for attribution; enough to cover a multi-minute block. */
const MAX_ENDED_MARKS = 64;
/** Cap on groups in one report, keeping it inside the telemetry byte budget. */
const MAX_GROUPS = 10;

const runningMarks = new Set<ActivityMark>();
const endedMarks: ActivityMark[] = [];

/** Narrow a conversation's stored type to the closed label set. */
export function turnConversationType(
  value: string | undefined,
): DaemonActivityLabel["conversationType"] {
  if (value === undefined) {
    return "standard";
  }
  return TURN_CONVERSATION_TYPES.has(value)
    ? (value as "standard" | "background" | "scheduled")
    : "other";
}

/** Run `fn` as a unit of tracked work. The mark closes however `fn` settles. */
export async function trackDaemonActivity<T>(
  label: DaemonActivityLabel,
  fn: () => Promise<T>,
): Promise<T> {
  const mark: ActivityMark = { label, startedAt: performance.now() };
  runningMarks.add(mark);
  try {
    return await fn();
  } finally {
    mark.endedAt = performance.now();
    runningMarks.delete(mark);
    endedMarks.push(mark);
    if (endedMarks.length > MAX_ENDED_MARKS) {
      endedMarks.shift();
    }
  }
}

/**
 * Work that overlapped the last `windowMs`, grouped by label, longest first.
 * A mark overlaps when it started before `now` and had not ended before the
 * window began.
 */
export function getActivityOverlapping(
  windowMs: number,
  now: number = performance.now(),
): DaemonActivityGroup[] {
  const windowStart = now - windowMs;
  const groups = new Map<string, DaemonActivityGroup>();
  for (const mark of [...runningMarks, ...endedMarks]) {
    const end = mark.endedAt ?? now;
    if (mark.startedAt > now || end < windowStart) {
      continue;
    }
    const key = JSON.stringify(mark.label);
    const durationMs = Math.round(end - mark.startedAt);
    const group = groups.get(key);
    if (group) {
      group.count++;
      group.running += mark.endedAt === undefined ? 1 : 0;
      group.longestMs = Math.max(group.longestMs, durationMs);
    } else {
      groups.set(key, {
        ...mark.label,
        count: 1,
        running: mark.endedAt === undefined ? 1 : 0,
        longestMs: durationMs,
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.longestMs - a.longestMs)
    .slice(0, MAX_GROUPS);
}

/** Test isolation only: the trail is process-global module state. */
export function resetActivityTrailForTests(): void {
  runningMarks.clear();
  endedMarks.length = 0;
}
