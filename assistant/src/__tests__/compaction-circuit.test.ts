/**
 * Tests for the `CompactionCircuit` class.
 *
 * The breaker logic lives as direct methods on the per-conversation
 * `CompactionCircuit` state container (`agent/compaction-circuit.ts`). These
 * tests assert the threshold (3 consecutive failures) and cooldown (1 hour)
 * exactly match the user-visible behavior:
 *   (a) counter increments on each failure outcome
 *   (b) circuit opens after exactly 3 consecutive failures
 *   (c) successful compaction resets counter and clears the circuit
 *   (d) isOpen() reflects state and cooldown expiry
 *   (e) circuit re-opens after cooldown expiry when 3 more failures
 *       accumulate (guards the stale-timestamp regression)
 *   (f) isOpen() is query-only and never mutates the counter
 *   (g) open→closed transition emits `compaction_circuit_closed` exactly once
 *   (h) closed→closed transition emits nothing
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  COMPACTION_CIRCUIT_COOLDOWN_MS,
  COMPACTION_CIRCUIT_FAILURE_THRESHOLD,
  CompactionCircuit,
} from "../agent/compaction-circuit.js";
import type { CompactionCircuitEvent } from "../plugins/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CONVERSATION_ID = "conv-breaker-test";

function collectEvents(): {
  events: CompactionCircuitEvent[];
  onEvent: (msg: CompactionCircuitEvent) => void;
} {
  const events: CompactionCircuitEvent[] = [];
  return { events, onEvent: (msg) => events.push(msg) };
}

describe("CompactionCircuit", () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  test("threshold and cooldown constants match the user-visible contract", () => {
    expect(COMPACTION_CIRCUIT_FAILURE_THRESHOLD).toBe(3);
    expect(COMPACTION_CIRCUIT_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });

  test("(a) counter increments on each failure outcome", async () => {
    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent, events } = collectEvents();

    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(1);
    expect(circuit.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(2);
    expect(circuit.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("(b) circuit opens after exactly 3 consecutive failures", async () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent, events } = collectEvents();

    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    // Two failures — circuit still closed.
    expect(circuit.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    await circuit.recordOutcome(true, onEvent);
    // Third failure — circuit trips and fires the event exactly once.
    expect(circuit.consecutiveCompactionFailures).toBe(3);
    expect(circuit.compactionCircuitOpenUntil).toBe(fixedNow + 60 * 60 * 1000);
    expect(await circuit.isOpen()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "compaction_circuit_open",
      conversationId: CONVERSATION_ID,
      reason: "3_consecutive_failures",
      openUntil: fixedNow + 60 * 60 * 1000,
    });

    // Further failures do not re-fire the event while the circuit is open.
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(4);
    expect(events).toHaveLength(1);
  });

  test("(c) successful outcome resets counter and clears circuit", async () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent } = collectEvents();

    // Trip the breaker.
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.compactionCircuitOpenUntil).not.toBeNull();

    // Success resets state.
    await circuit.recordOutcome(false, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(0);
    expect(circuit.compactionCircuitOpenUntil).toBeNull();
  });

  test("(d) isOpen() reflects state and expiry", async () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent } = collectEvents();

    // Fresh state: closed.
    expect(await circuit.isOpen()).toBe(false);

    // Trip the breaker.
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);

    // While open.
    expect(await circuit.isOpen()).toBe(true);

    // After cooldown expires the breaker reports closed again, even without
    // an explicit reset — the open-until timestamp is the only source of
    // truth for the gate.
    Date.now = () => fixedNow + 60 * 60 * 1000 + 1;
    expect(await circuit.isOpen()).toBe(false);
  });

  test("(e) circuit re-opens after cooldown expiry when 3 more failures accumulate", async () => {
    // Regression: opening the breaker a second time must not require
    // `compactionCircuitOpenUntil === null`. Once a cooldown expires, the
    // gate correctly reports "closed" but a stale past-timestamp stays on the
    // state, so the next 3-strike window must still trip a new cooldown. Any
    // expired timestamp is treated the same as null.
    const t0 = 1_700_000_000_000;
    Date.now = () => t0;

    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent, events } = collectEvents();

    // Trip the breaker the first time.
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.compactionCircuitOpenUntil).toBe(t0 + 60 * 60 * 1000);
    expect(events).toHaveLength(1);

    // Advance past the cooldown window. Reset the counter — in production this
    // happens when a subsequent `maybeCompact` call succeeds after the
    // cooldown elapses, but the bug manifests even when the counter is reset:
    // the stale `compactionCircuitOpenUntil` is what breaks re-opening.
    const t1 = t0 + 60 * 60 * 1000 + 1;
    Date.now = () => t1;
    expect(await circuit.isOpen()).toBe(false);
    circuit.consecutiveCompactionFailures = 0;
    // `compactionCircuitOpenUntil` is deliberately left as the old timestamp
    // to reproduce the bug condition.
    expect(circuit.compactionCircuitOpenUntil).toBe(t0 + 60 * 60 * 1000);

    // Three more failures must trip a fresh cooldown even though the old
    // timestamp is still set.
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(3);
    expect(circuit.compactionCircuitOpenUntil).toBe(t1 + 60 * 60 * 1000);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "compaction_circuit_open",
      conversationId: CONVERSATION_ID,
      reason: "3_consecutive_failures",
      openUntil: t1 + 60 * 60 * 1000,
    });
  });

  test("(f) isOpen() is query-only and never mutates the counter", async () => {
    // `maybeCompact()` early-return paths skip `recordOutcome` entirely and
    // only gate on `isOpen()`. The query must never touch the 3-strike
    // counter so those early returns can't silently reset it.
    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent } = collectEvents();

    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(2);

    // Query-only — must NOT touch the counter.
    expect(await circuit.isOpen()).toBe(false);
    expect(circuit.consecutiveCompactionFailures).toBe(2);

    // A third real failure then trips the breaker as expected.
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(3);
    expect(circuit.compactionCircuitOpenUntil).not.toBeNull();
  });

  test("(g) open→closed transition emits compaction_circuit_closed exactly once", async () => {
    // Regression: the reset branch must notify the client on open→closed.
    // Otherwise the Swift banner set from `compaction_circuit_open` stays
    // visible until the original `openUntil` deadline (up to 1h),
    // misrepresenting the live state.
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent, events } = collectEvents();

    // Force the circuit into the open state directly — the emitted-event
    // transition logic is what we're testing, not the tripping path.
    circuit.compactionCircuitOpenUntil = fixedNow + 60 * 60 * 1000;
    circuit.consecutiveCompactionFailures = 3;

    await circuit.recordOutcome(false, onEvent);

    expect(circuit.consecutiveCompactionFailures).toBe(0);
    expect(circuit.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "compaction_circuit_closed",
      conversationId: CONVERSATION_ID,
    });
  });

  test("(h) successful outcome against an already-closed circuit emits no event", async () => {
    // Emitting `compaction_circuit_closed` on every successful compaction
    // would spam the client (the breaker is closed in the common case).
    // Only the open→closed transition is meaningful.
    const circuit = new CompactionCircuit(CONVERSATION_ID);
    const { onEvent, events } = collectEvents();

    expect(circuit.compactionCircuitOpenUntil).toBeNull();
    await circuit.recordOutcome(false, onEvent);
    expect(circuit.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    // A second successful outcome while still closed — still no event.
    await circuit.recordOutcome(false, onEvent);
    expect(events).toHaveLength(0);
  });
});
