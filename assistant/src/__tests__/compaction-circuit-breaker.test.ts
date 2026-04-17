/**
 * Circuit-breaker tests for the compaction path.
 *
 * These exercise the tiny helpers (`isCompactionCircuitOpen`,
 * `trackCompactionOutcome`) that `conversation-agent-loop.ts` uses at every
 * `maybeCompact()` call site. Covering the helpers — rather than wiring up a
 * full `Conversation` — keeps the test fast and isolates the breaker logic
 * from the rest of the loop, which is where bugs actually hide.
 *
 * Acceptance criteria (per plan PR 2):
 *   (a) counter increments on `summaryFailed`
 *   (b) circuit opens after exactly 3 failures
 *   (c) successful compaction resets counter and circuit
 *   (d) open circuit skips auto-compaction but admits `force: true`
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isCompactionCircuitOpen,
  trackCompactionOutcome,
} from "../daemon/conversation-agent-loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

interface BreakerState {
  consecutiveCompactionFailures: number;
  compactionCircuitOpenUntil: number | null;
}

function makeState(): BreakerState {
  return {
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

    // `summaryFailed` undefined (never attempted the LLM call) also counts
    // as "not failed" — don't count a compaction that never ran.
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
});
