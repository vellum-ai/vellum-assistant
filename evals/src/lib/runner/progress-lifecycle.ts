/**
 * Per-run progress + heartbeat lifecycle.
 *
 * `runEvalOnce` (simulator-driven path) and `runLongMemEvalV2Unit`
 * (LongMemEval-V2 two-conversation path) both want the same wiring at
 * the top of their try/finally block:
 *
 *   - a wrapped `EvalProgressReporter` that tees every event to the
 *     caller's reporter (best-effort — never break a run on a misbehaving
 *     consumer), appends a timestamped copy to `progress.ndjson` for the
 *     report server, and bumps the heartbeat file so a stalled run shows
 *     up in the dashboard right away rather than after the next ticker
 *     fire
 *   - a 5s heartbeat ticker that touches the heartbeat file on its own
 *     schedule so the dashboard's "running, last seen N seconds ago"
 *     view stays accurate even when no progress events are flowing
 *     (e.g. during the agent's long internal turn)
 *
 * Both spots used to inline the same wrapper + ticker block — flagged
 * with `// PR-6 follow-up` markers in
 * `benchmarks/longmemeval-v2/src/runner.ts`. This module is that
 * extract. Callers do:
 *
 *     const { progress, dispose } = createRunProgressLifecycle({
 *       runId: input.runId,
 *       userProgress: input.progress,
 *     });
 *     try {
 *       progress({ step: "artifacts", status: "start", ... });
 *       // ... use `progress` everywhere ...
 *     } finally {
 *       dispose();
 *       // ... rest of cleanup ...
 *     }
 *
 * `dispose()` is idempotent so a finally-block that also runs through
 * a re-throw path doesn't have to guard against double-clear.
 */
import { setInterval as nodeSetInterval } from "node:timers";

import { appendProgressEvent, updateHeartbeat } from "../metrics";

import type { EvalProgressEvent, EvalProgressReporter } from "./progress";

/** Heartbeat tick interval used by the runners. 5 seconds matches what
 *  the dashboard polls at, so a missing tick is loud within one frame. */
export const DEFAULT_HEARTBEAT_MS = 5_000;

export interface CreateRunProgressLifecycleInput {
  /** Logical run id — used as the key for `progress.ndjson` + the heartbeat file. */
  runId: string;
  /**
   * Optional caller-side reporter. The wrapped reporter tees every
   * event to it inside a `try { ... } catch {}` block so a misbehaving
   * consumer (one that throws, or one that mutates and re-throws)
   * never propagates the failure back into the runner's lifecycle.
   */
  userProgress?: EvalProgressReporter;
  /**
   * Tick interval for the standalone heartbeat ticker, in ms.
   * Defaults to {@link DEFAULT_HEARTBEAT_MS}. The wrapped progress
   * reporter also bumps the heartbeat on every event regardless of
   * this interval, so the ticker is the "no events are flowing"
   * backstop, not the only liveness signal.
   */
  heartbeatMs?: number;
}

export interface RunProgressLifecycle {
  /**
   * Wrapped progress reporter. Pass this to whatever subsystem emits
   * progress events; the caller's `userProgress` reporter (if any)
   * is fanned out behind the scenes alongside the on-disk persistence.
   */
  progress: EvalProgressReporter;
  /**
   * Stop the heartbeat ticker. Idempotent — safe to call from a
   * `finally` block that also runs as part of a re-thrown error
   * path. After dispose, `progress` still works (no-op heartbeat
   * ticker, but the on-event heartbeat bump still fires inside the
   * wrapped reporter) — callers SHOULD stop emitting through it,
   * but they don't have to add a guard.
   */
  dispose: () => void;
}

/**
 * Build a wrapped progress reporter + standalone heartbeat ticker
 * bound to a single run id. See module docstring for the call site
 * shape.
 */
export function createRunProgressLifecycle(
  input: CreateRunProgressLifecycleInput,
): RunProgressLifecycle {
  const { runId, userProgress, heartbeatMs = DEFAULT_HEARTBEAT_MS } = input;

  // Serializes `progress.ndjson` appends so order on disk matches
  // emission order even when callers fire two progress events in the
  // same synchronous tick. Errors at any link are swallowed so a single
  // failure doesn't poison subsequent appends.
  let appendChain: Promise<void> = Promise.resolve();

  const progress: EvalProgressReporter = (event: EvalProgressEvent) => {
    if (userProgress) {
      try {
        userProgress(event);
      } catch {
        // Best-effort reporting — never break a run because a caller's
        // reporter threw. The on-disk persistence + heartbeat below
        // still fire.
      }
    }
    // Persistence is best-effort: a failed append (disk full,
    // permission flake) is logged via the swallowed promise but never
    // blocks the run.
    // Chain appends so two synchronous progress() calls in a row land
    // on disk in emission order. Without this, parallel appendFile
    // calls race and `progress.ndjson` can show events out of order —
    // the report server reads that file as a timeline so order
    // matters. Heartbeat bumps don't need ordering (they all write the
    // same key) so they stay fire-and-forget.
    const emittedAt = new Date().toISOString();
    appendChain = appendChain
      .then(() => appendProgressEvent(runId, { ...event, emittedAt }))
      .catch(() => undefined);
    void updateHeartbeat(runId).catch(() => undefined);
  };

  // Standalone heartbeat ticker — fires on a fixed schedule regardless
  // of whether any progress events are flowing. Cleared by `dispose()`.
  // `.unref()` so the timer never keeps the event loop alive past a
  // clean run completion — `clearInterval` in `dispose` is still the
  // primary stop, this is the safety net for a runner that forgets to
  // dispose at all.
  const heartbeatInterval = nodeSetInterval(() => {
    void updateHeartbeat(runId).catch(() => undefined);
  }, heartbeatMs);
  heartbeatInterval.unref();

  let disposed = false;
  return {
    progress,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeatInterval);
    },
  };
}
