/**
 * Circuit-breaker tests for the compaction path.
 *
 * These exercise the tiny helpers (`isCompactionCircuitOpen`,
 * `trackCompactionOutcome`) that `conversation-agent-loop.ts` uses at every
 * `maybeCompact()` call site. Covering the helpers — rather than wiring up a
 * full `Conversation` — keeps the test fast and isolates the breaker logic
 * from the rest of the loop, which is where bugs actually hide.
 *
 * Acceptance criteria:
 *   (a) counter increments on `summaryFailed`
 *   (b) circuit opens after exactly 3 failures
 *   (c) successful compaction resets counter and circuit
 *   (d) open circuit skips auto-compaction but admits `force: true`
 *   (e) circuit re-opens after cooldown expiry when 3 more failures accumulate
 *   (f) call sites guard `undefined summaryFailed` so early returns do not
 *       reset the counter
 *   (g) forceCompact-style tracking: resets counter on success, increments on
 *       failure, preserves state on early returns
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isCompactionCircuitOpen,
  trackCompactionOutcome,
} from "../daemon/conversation-agent-loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

interface BreakerState {
  readonly conversationId: string;
  consecutiveCompactionFailures: number;
  compactionCircuitOpenUntil: number | null;
}

function makeState(conversationId = "conv-breaker-test"): BreakerState {
  return {
    conversationId,
    consecutiveCompactionFailures: 0,
    compactionCircuitOpenUntil: null,
  };
}

function collectEvents(): {
  events: ServerMessage[];
  onEvent: (msg: ServerMessage) => void;
} {
  const events: ServerMessage[] = [];
  return { events, onEvent: (msg) => events.push(msg) };
}

describe("compaction circuit breaker", () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  test("(a) counter increments on each summaryFailed outcome", () => {
    const state = makeState();
    const { onEvent, events } = collectEvents();

    trackCompactionOutcome(state, true, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(1);
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    trackCompactionOutcome(state, true, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(2);
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("(b) circuit opens after exactly 3 consecutive failures", () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    const { onEvent, events } = collectEvents();

    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    // Two failures — circuit still closed.
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    trackCompactionOutcome(state, true, onEvent);
    // Third failure — circuit trips and fires the event exactly once.
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).toBe(fixedNow + 60 * 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "compaction_circuit_open",
      conversationId: state.conversationId,
      reason: "3_consecutive_failures",
      openUntil: fixedNow + 60 * 60 * 1000,
    });

    // Further failures do not re-fire the event while the circuit is open.
    trackCompactionOutcome(state, true, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(4);
    expect(events).toHaveLength(1);
  });

  test("(c) successful compaction resets counter and clears circuit", () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    const { onEvent } = collectEvents();

    // Trip the breaker.
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    expect(state.compactionCircuitOpenUntil).not.toBeNull();

    // Success resets state.
    trackCompactionOutcome(state, false, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(0);
    expect(state.compactionCircuitOpenUntil).toBeNull();

    // `summaryFailed` undefined (never attempted the LLM call) currently
    // takes the "not failed" branch, which is why callers must guard the
    // helper with `summaryFailed !== undefined` — otherwise an early-return
    // `maybeCompact()` would silently reset the counter. The regression test
    // below documents that invariant from the caller's perspective.
    trackCompactionOutcome(state, undefined, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(0);
    expect(state.compactionCircuitOpenUntil).toBeNull();
  });

  test("(d) isCompactionCircuitOpen reflects state and expiry", () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    expect(isCompactionCircuitOpen(state)).toBe(false);

    // Trip the breaker — now open.
    const { onEvent } = collectEvents();
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    expect(isCompactionCircuitOpen(state)).toBe(true);

    // After cooldown expires the helper reports closed again, even without an
    // explicit reset — the open-until timestamp is the only source of truth
    // for the gate.
    Date.now = () => fixedNow + 60 * 60 * 1000 + 1;
    expect(isCompactionCircuitOpen(state)).toBe(false);
  });

  test("(d) open circuit skips auto-compaction but admits force:true", () => {
    // Simulate the decision the agent-loop site makes with a counter that
    // only increments when compaction actually runs.
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    const { onEvent } = collectEvents();

    let compactionCalls = 0;
    const runCompactionIfAllowed = (opts: { force?: boolean }) => {
      // Mirror conversation-agent-loop.ts site 1:
      //   auto paths gate on !isCompactionCircuitOpen(ctx);
      //   force paths bypass the gate.
      if (!opts.force && isCompactionCircuitOpen(state)) {
        return { ran: false };
      }
      compactionCalls += 1;
      return { ran: true };
    };

    // Trip the breaker.
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    expect(isCompactionCircuitOpen(state)).toBe(true);

    // Auto-path is skipped while the circuit is open.
    const autoAttempt = runCompactionIfAllowed({});
    expect(autoAttempt.ran).toBe(false);
    expect(compactionCalls).toBe(0);

    // Force-path always runs, even with the breaker open.
    const forceAttempt = runCompactionIfAllowed({ force: true });
    expect(forceAttempt.ran).toBe(true);
    expect(compactionCalls).toBe(1);

    // After a forced compaction succeeds, the counter resets and the circuit
    // closes, unblocking future auto attempts.
    trackCompactionOutcome(state, false, onEvent);
    expect(isCompactionCircuitOpen(state)).toBe(false);
    expect(state.consecutiveCompactionFailures).toBe(0);

    const autoRetry = runCompactionIfAllowed({});
    expect(autoRetry.ran).toBe(true);
    expect(compactionCalls).toBe(2);
  });

  test("(e) circuit re-opens after cooldown expiry when 3 more failures accumulate", () => {
    // Regression: before the fix, `trackCompactionOutcome` required
    // `compactionCircuitOpenUntil === null` to open the circuit. Once a
    // cooldown expired, `isCompactionCircuitOpen()` correctly reported
    // "closed" but the stale past-timestamp stayed on the state, so the
    // next 3-strike window could never trip a new cooldown. The fix
    // treats any expired timestamp the same as null.
    const t0 = 1_700_000_000_000;
    Date.now = () => t0;

    const state = makeState();
    const { onEvent, events } = collectEvents();

    // Trip the breaker the first time.
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    expect(state.compactionCircuitOpenUntil).toBe(t0 + 60 * 60 * 1000);
    expect(events).toHaveLength(1);

    // Advance past the cooldown window. Manually reset the counter — in
    // production this happens when a subsequent `maybeCompact()` call
    // succeeds (`summaryFailed: false`) after the cooldown elapses, but
    // the bug manifests even when the counter is reset: the stale
    // `compactionCircuitOpenUntil` is what breaks re-opening.
    const t1 = t0 + 60 * 60 * 1000 + 1;
    Date.now = () => t1;
    expect(isCompactionCircuitOpen(state)).toBe(false);
    state.consecutiveCompactionFailures = 0;
    // `compactionCircuitOpenUntil` is deliberately left as the old
    // timestamp to reproduce the bug condition — in practice the null
    // reset only happens on `summaryFailed: false`.
    expect(state.compactionCircuitOpenUntil).toBe(t0 + 60 * 60 * 1000);

    // Three more failures must trip a fresh cooldown even though the
    // old timestamp is still set.
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).toBe(t1 + 60 * 60 * 1000);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "compaction_circuit_open",
      conversationId: state.conversationId,
      reason: "3_consecutive_failures",
      openUntil: t1 + 60 * 60 * 1000,
    });
  });

  test("(f) call sites guard undefined summaryFailed so early returns don't reset the counter", () => {
    // Regression: `maybeCompact()` returns `summaryFailed: undefined` on
    // early-return paths (no eligible messages, below threshold, cooldown
    // active, truncation-only). Before the fix, the agent loop called
    // `trackCompactionOutcome(ctx, compacted.summaryFailed, onEvent)`
    // unconditionally — `undefined` took the else branch and silently
    // reset the 3-strike counter. Callers must now guard with
    // `summaryFailed !== undefined` at every call site.
    const state = makeState();
    const { onEvent } = collectEvents();

    // Accumulate two failures, close to tripping the breaker.
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(2);

    // Simulate an early-return result from maybeCompact() (e.g. below
    // threshold) — callers must skip the tracking call entirely.
    const earlyReturn = {
      compacted: false,
      summaryFailed: undefined as boolean | undefined,
    };
    if (earlyReturn.summaryFailed !== undefined) {
      trackCompactionOutcome(state, earlyReturn.summaryFailed, onEvent);
    }
    // Counter preserved — the early return did not reset progress toward
    // tripping the breaker.
    expect(state.consecutiveCompactionFailures).toBe(2);

    // A third real failure then trips the breaker as expected.
    trackCompactionOutcome(state, true, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).not.toBeNull();
  });

  test("(g) forceCompact-style tracking resets counter on success, increments on failure", () => {
    // Regression: `Conversation.forceCompact()` previously didn't track
    // circuit-breaker outcomes. A successful user `/compact` wouldn't clear
    // an accumulating counter and a failed forced compaction wouldn't
    // contribute to tripping the breaker. The fix calls
    // `trackCompactionOutcome(this, result.summaryFailed, this.sendToClient)`
    // after `maybeCompact` — guarded by `summaryFailed !== undefined` so
    // early-return paths don't reset the counter.
    const state = makeState();
    const { onEvent } = collectEvents();

    // Simulate forceCompact: call maybeCompact with force:true, then
    // track the outcome the same way forceCompact now does.
    const trackForceCompact = (result: {
      summaryFailed?: boolean;
      compacted: boolean;
    }): void => {
      if (result.summaryFailed !== undefined) {
        trackCompactionOutcome(state, result.summaryFailed, onEvent);
      }
    };

    // Two failures via the auto path …
    trackCompactionOutcome(state, true, onEvent);
    trackCompactionOutcome(state, true, onEvent);
    expect(state.consecutiveCompactionFailures).toBe(2);

    // … then the user hits /compact and the forced call succeeds. This
    // must clear the stuck counter so the conversation isn't one
    // auto-failure away from a cooldown.
    trackForceCompact({ summaryFailed: false, compacted: true });
    expect(state.consecutiveCompactionFailures).toBe(0);
    expect(state.compactionCircuitOpenUntil).toBeNull();

    // Conversely, three forced failures must trip the breaker too — a
    // run of broken summaries is a provider-health signal regardless of
    // whether the caller bypassed the breaker.
    trackForceCompact({ summaryFailed: true, compacted: true });
    trackForceCompact({ summaryFailed: true, compacted: true });
    trackForceCompact({ summaryFailed: true, compacted: true });
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).not.toBeNull();

    // An early-return forceCompact (e.g. no eligible messages) must not
    // reset the counter — the breaker should stay open.
    const wasOpenUntil = state.compactionCircuitOpenUntil;
    trackForceCompact({ summaryFailed: undefined, compacted: false });
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).toBe(wasOpenUntil);
  });
});
