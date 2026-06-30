/**
 * Periodic reaper for conversation processing flags stranded by a turn that
 * died without reaching its cleanup `finally` while the daemon kept running.
 *
 * A turn marks its conversation processing by writing `processing_started_at`
 * (via `Conversation.setProcessing(true)`); the agent loop's `finally` is
 * meant to clear it when the turn ends. The submit gates read that flag and
 * reject new messages with "Conversation is already processing a message", so
 * a flag stranded by a turn that never reached its `finally` (a crash or hang
 * outside the abort watchdog's single wrapped call) silently swallows every
 * subsequent message to that conversation until the daemon restarts.
 *
 * `clearStaleProcessingFlags` already resets every set flag at startup, on the
 * reasoning that the previous process's in-memory agent loops are all gone.
 * That only fires once per process, so a turn that dies mid-process leaves its
 * flag latched for the daemon's entire remaining lifetime. This reaper is the
 * running-daemon counterpart: a periodic sweep that releases flags older than
 * a staleness ceiling.
 *
 * Safety against reaping a genuinely long (but live) turn rests on two things:
 *
 *   1. The ceiling is set well above any plausible turn duration (default 30
 *      minutes), so a flag reaching it is overwhelmingly likely to be dead.
 *
 *   2. A two-phase grace window, mirroring the orphan reaper's "survive one
 *      interval" pattern. On the first sweep a conversation is seen over the
 *      ceiling, the reaper fires a cooperative `abort()` — if a live loop is
 *      driving that turn, abort propagates into the provider/tool calls and
 *      the loop unwinds through its `finally`, clearing the flag itself within
 *      seconds (well inside one sweep interval). Only a flag that is STILL set
 *      a full interval later — i.e. abort found no live loop to unwind — is
 *      force-cleared. A genuinely live turn therefore clears its own flag and
 *      is never force-cleared out from under itself; only a truly dead turn
 *      survives to the force-clear pass.
 *
 * Force-clearing distinguishes resident from cold conversations. A resident
 * conversation's in-memory `_processing` flag is what the hot-path submit gate
 * reads, so it must be cleared via `setProcessing(false)` (which also nulls the
 * column); a raw column write alone would leave the in-memory gate latched. A
 * cold (evicted / never-loaded) conversation has no in-memory state and no
 * live loop, so its column is cleared directly.
 */

import {
  findProcessingConversationsStartedBefore,
  setConversationProcessingStartedAt,
} from "../persistence/conversation-crud.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { findConversation } from "./conversation-registry.js";

const log = getLogger("stale-processing-reaper");

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Conversation ids seen over the staleness ceiling on the previous sweep. An
 * id present here and still over the ceiling this sweep has survived a full
 * interval after its graceful abort, so it is force-cleared. Reset on stop.
 */
let seenLastSweep: Set<string> = new Set();

interface StaleProcessingReaperOptions {
  /** Max age (ms) a processing flag may reach before it is treated as stale. */
  ceilingMs: number;
  /** Interval (ms) between sweeps; also the grace window before force-clear. */
  sweepIntervalMs: number;
}

/**
 * Partition this sweep's over-ceiling ids into those to abort (newly over the
 * ceiling — give the turn a graceful nudge and a grace interval to unwind) and
 * those to force-clear (still over the ceiling a full interval after their
 * abort, so no live loop unwound them). Pure for testability; mirrors the
 * orphan reaper's `selectReapable`.
 */
export function selectStaleActions(
  currentStaleIds: string[],
  seenLast: Set<string>,
): { abort: string[]; forceClear: string[]; nextSeen: Set<string> } {
  const abort: string[] = [];
  const forceClear: string[] = [];
  for (const id of currentStaleIds) {
    if (seenLast.has(id)) forceClear.push(id);
    else abort.push(id);
  }
  return { abort, forceClear, nextSeen: new Set(currentStaleIds) };
}

/**
 * Run one sweep: find flags older than the ceiling, gracefully abort the
 * newly-stale, and force-clear those that survived their grace interval.
 * Exported for tests; the timer calls this.
 */
export function runStaleProcessingSweep(options: StaleProcessingReaperOptions): {
  aborted: number;
  forceCleared: number;
} {
  const cutoff = Date.now() - options.ceilingMs;
  const stale = findProcessingConversationsStartedBefore(cutoff);
  const { abort, forceClear, nextSeen } = selectStaleActions(
    stale.map((row) => row.id),
    seenLastSweep,
  );
  seenLastSweep = nextSeen;

  let aborted = 0;
  for (const id of abort) {
    const conversation = findConversation(id);
    // A cold conversation has no live loop to nudge — skip straight to the
    // force-clear pass on the next sweep (or it would already be cold-cleared
    // there). Only resident conversations can have a loop worth aborting.
    if (!conversation) continue;
    try {
      conversation.abort(
        createAbortReason(
          "stale_processing_reaped",
          "staleProcessingReaper:abort",
          id,
        ),
      );
      aborted++;
    } catch (err) {
      log.warn(
        { err, conversationId: id },
        "Stale-processing reaper failed to abort over-ceiling conversation",
      );
    }
  }

  let forceCleared = 0;
  for (const id of forceClear) {
    try {
      const conversation = findConversation(id);
      if (conversation) {
        // Resident: clear the in-memory gate (and the column) so the hot-path
        // submit check stops rejecting messages. abort() first tears down any
        // lingering controller/queue while still flagged processing.
        conversation.abort(
          createAbortReason(
            "stale_processing_reaped",
            "staleProcessingReaper:forceClear",
            id,
          ),
        );
        conversation.setProcessing(false);
      } else {
        // Cold: no in-memory state and no live loop possible; clear the column.
        setConversationProcessingStartedAt(id, null);
      }
      forceCleared++;
    } catch (err) {
      log.warn(
        { err, conversationId: id },
        "Stale-processing reaper failed to force-clear stale processing flag",
      );
    }
  }

  if (aborted > 0 || forceCleared > 0) {
    log.info(
      { aborted, forceCleared, ceilingMs: options.ceilingMs },
      "Stale-processing reaper swept over-ceiling conversation processing flags",
    );
  }

  return { aborted, forceCleared };
}

/**
 * Start the periodic stale-processing reaper. No-op if already running.
 */
export function startStaleProcessingReaper(
  options: StaleProcessingReaperOptions,
): void {
  if (sweepTimer) return;
  seenLastSweep = new Set();
  sweepTimer = setInterval(() => {
    try {
      runStaleProcessingSweep(options);
    } catch (err) {
      log.warn({ err }, "Stale-processing reaper sweep failed");
    }
  }, options.sweepIntervalMs);
  sweepTimer.unref?.();
  log.info(
    {
      ceilingMs: options.ceilingMs,
      sweepIntervalMs: options.sweepIntervalMs,
    },
    "Stale-processing reaper started",
  );
}

export function stopStaleProcessingReaper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  seenLastSweep = new Set();
}
