/**
 * Tests for the `circuitBreaker` plugin pipeline.
 *
 * The default plugin (`plugins/defaults/circuit-breaker.ts`) replaces the
 * inline compaction circuit-breaker logic that previously lived in
 * `daemon/conversation-agent-loop.ts`. These tests exercise the default
 * plugin through the pipeline runner and assert the threshold (3 consecutive
 * failures) and cooldown (1 hour) exactly match the legacy behavior.
 *
 * Coverage mirrors the eight scenarios the deleted
 * `compaction-circuit-breaker.test.ts` exercised before the wrap:
 *   (a) counter increments on each failure outcome
 *   (b) circuit opens after exactly 3 consecutive failures
 *   (c) successful compaction resets counter and clears the circuit
 *   (d) decision.open reflects state and cooldown expiry
 *   (d) open circuit admits force:true (exercised at the call site; this
 *       file asserts decision.open is true while the breaker is tripped)
 *   (e) circuit re-opens after cooldown expiry when 3 more failures
 *       accumulate (guards the stale-timestamp regression)
 *   (f) callers skip tracking on undefined summaryFailed so early returns
 *       don't reset the counter (documented from the caller's perspective)
 *   (g) open→closed transition emits `compaction_circuit_closed` exactly once
 *   (h) closed→closed transition emits nothing
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import {
  COMPACTION_CIRCUIT_COOLDOWN_MS,
  COMPACTION_CIRCUIT_FAILURE_THRESHOLD,
  defaultCircuitBreakerPlugin,
} from "../plugins/defaults/circuit-breaker.js";
import { runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  CircuitBreakerArgs,
  CircuitBreakerResult,
  TurnContext,
} from "../plugins/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeTurnCtx(conversationId = "conv-breaker-test"): TurnContext {
  return {
    requestId: "req-test",
    conversationId,
    turnIndex: 0,
    trust,
  };
}

/**
 * Run the `circuitBreaker` pipeline through the registered plugin chain.
 * Mirrors how `conversation-agent-loop.ts` invokes it, with the same
 * terminal fallback used in production.
 */
async function runCircuit(
  args: CircuitBreakerArgs,
  ctx: TurnContext = makeTurnCtx(args.state.conversationId),
): Promise<CircuitBreakerResult> {
  return runPipeline<CircuitBreakerArgs, CircuitBreakerResult>(
    "circuitBreaker",
    getMiddlewaresFor("circuitBreaker"),
    async (terminalArgs) => {
      const openUntil = terminalArgs.state.compactionCircuitOpenUntil;
      const now = Date.now();
      if (openUntil !== null && now < openUntil) {
        return { open: true, cooldownRemainingMs: openUntil - now };
      }
      return { open: false };
    },
    args,
    ctx,
    500,
  );
}

describe("circuit-breaker pipeline", () => {
  let originalDateNow: () => number;

  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultCircuitBreakerPlugin);
    originalDateNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  test("threshold and cooldown match legacy constants exactly", () => {
    // Sanity — the plugin must expose the same constants the legacy inline
    // helpers used. Any drift would silently change user-visible behavior.
    expect(COMPACTION_CIRCUIT_FAILURE_THRESHOLD).toBe(3);
    expect(COMPACTION_CIRCUIT_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });

  test("(a) counter increments on each failure outcome", async () => {
    const state = makeState();
    const { onEvent, events } = collectEvents();

    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    expect(state.consecutiveCompactionFailures).toBe(1);
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    expect(state.consecutiveCompactionFailures).toBe(2);
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("(b) circuit opens after exactly 3 consecutive failures", async () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    const { onEvent, events } = collectEvents();

    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    // Two failures — circuit still closed.
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    const third = await runCircuit({
      key: "k",
      outcome: "failure",
      state,
      onEvent,
    });
    // Third failure — circuit trips and fires the event exactly once.
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).toBe(fixedNow + 60 * 60 * 1000);
    expect(third.open).toBe(true);
    expect(third.cooldownRemainingMs).toBe(60 * 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "compaction_circuit_open",
      conversationId: state.conversationId,
      reason: "3_consecutive_failures",
      openUntil: fixedNow + 60 * 60 * 1000,
    });

    // Further failures do not re-fire the event while the circuit is open.
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    expect(state.consecutiveCompactionFailures).toBe(4);
    expect(events).toHaveLength(1);
  });

  test("(c) successful outcome resets counter and clears circuit", async () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    const { onEvent } = collectEvents();

    // Trip the breaker.
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    expect(state.compactionCircuitOpenUntil).not.toBeNull();

    // Success resets state.
    await runCircuit({ key: "k", outcome: "success", state, onEvent });
    expect(state.consecutiveCompactionFailures).toBe(0);
    expect(state.compactionCircuitOpenUntil).toBeNull();
  });

  test("(d) decision.open reflects state and expiry", async () => {
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    const { onEvent } = collectEvents();

    // Query-only on a fresh state: closed, no cooldown.
    const preQuery = await runCircuit({ key: "k", state, onEvent });
    expect(preQuery.open).toBe(false);
    expect(preQuery.cooldownRemainingMs).toBeUndefined();

    // Trip the breaker.
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });

    // Query-only while open: open + non-zero cooldown.
    const openQuery = await runCircuit({ key: "k", state, onEvent });
    expect(openQuery.open).toBe(true);
    expect(openQuery.cooldownRemainingMs).toBe(60 * 60 * 1000);

    // After cooldown expires the breaker reports closed again, even without
    // an explicit reset — the open-until timestamp is the only source of
    // truth for the gate.
    Date.now = () => fixedNow + 60 * 60 * 1000 + 1;
    const postCooldown = await runCircuit({ key: "k", state, onEvent });
    expect(postCooldown.open).toBe(false);
    expect(postCooldown.cooldownRemainingMs).toBeUndefined();
  });

  test("(e) circuit re-opens after cooldown expiry when 3 more failures accumulate", async () => {
    // Regression: before the fix in the legacy helper, opening the breaker a
    // second time required `compactionCircuitOpenUntil === null`. Once a
    // cooldown expired, the decision correctly reported "closed" but the
    // stale past-timestamp stayed on the state, so the next 3-strike window
    // couldn't trip a new cooldown. The default plugin must treat any
    // expired timestamp the same as null.
    const t0 = 1_700_000_000_000;
    Date.now = () => t0;

    const state = makeState();
    const { onEvent, events } = collectEvents();

    // Trip the breaker the first time.
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    expect(state.compactionCircuitOpenUntil).toBe(t0 + 60 * 60 * 1000);
    expect(events).toHaveLength(1);

    // Advance past the cooldown window. Manually reset the counter — in
    // production this happens when a subsequent `maybeCompact` call succeeds
    // (outcome: "success") after the cooldown elapses, but the bug
    // manifests even when the counter is reset: the stale
    // `compactionCircuitOpenUntil` is what breaks re-opening.
    const t1 = t0 + 60 * 60 * 1000 + 1;
    Date.now = () => t1;
    const postCooldown = await runCircuit({ key: "k", state, onEvent });
    expect(postCooldown.open).toBe(false);
    state.consecutiveCompactionFailures = 0;
    // `compactionCircuitOpenUntil` is deliberately left as the old
    // timestamp to reproduce the bug condition.
    expect(state.compactionCircuitOpenUntil).toBe(t0 + 60 * 60 * 1000);

    // Three more failures must trip a fresh cooldown even though the old
    // timestamp is still set.
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
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

  test("(f) callers must skip tracking on undefined summaryFailed so early returns don't reset the counter", async () => {
    // Regression: `maybeCompact()` returns `summaryFailed: undefined` on
    // early-return paths (no eligible messages, below threshold, cooldown
    // active, truncation-only). Callers guard with `summaryFailed !==
    // undefined` at every call site — this test asserts that a query-only
    // pipeline invocation (no `outcome`) preserves the counter.
    const state = makeState();
    const { onEvent } = collectEvents();

    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    expect(state.consecutiveCompactionFailures).toBe(2);

    // Query-only — should NOT touch the counter.
    await runCircuit({ key: "k", state, onEvent });
    expect(state.consecutiveCompactionFailures).toBe(2);

    // A third real failure then trips the breaker as expected.
    await runCircuit({ key: "k", outcome: "failure", state, onEvent });
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).not.toBeNull();
  });

  test("(g) open→closed transition emits compaction_circuit_closed exactly once", async () => {
    // Regression: before this fix in the legacy helper, the reset branch
    // silently cleared `compactionCircuitOpenUntil` without notifying the
    // client. The Swift banner set from `compaction_circuit_open` would
    // stay visible until the original `openUntil` deadline (up to 1h),
    // misrepresenting the live state. The default plugin emits
    // `compaction_circuit_closed` on the open→closed transition so the
    // banner dismisses immediately.
    const fixedNow = 1_700_000_000_000;
    Date.now = () => fixedNow;

    const state = makeState();
    const { onEvent, events } = collectEvents();

    // Force the circuit into the open state directly — the emitted-event
    // transition logic is what we're testing, not the tripping path.
    state.compactionCircuitOpenUntil = fixedNow + 60 * 60 * 1000;
    state.consecutiveCompactionFailures = 3;

    await runCircuit({ key: "k", outcome: "success", state, onEvent });

    expect(state.consecutiveCompactionFailures).toBe(0);
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "compaction_circuit_closed",
      conversationId: state.conversationId,
    });
  });

  test("(h) successful outcome against an already-closed circuit emits no event", async () => {
    // Emitting `compaction_circuit_closed` on every successful compaction
    // would spam the client (the breaker is closed in the common case).
    // Only the open→closed transition is meaningful.
    const state = makeState();
    const { onEvent, events } = collectEvents();

    expect(state.compactionCircuitOpenUntil).toBeNull();
    await runCircuit({ key: "k", outcome: "success", state, onEvent });
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    // A second successful outcome while still closed — still no event.
    await runCircuit({ key: "k", outcome: "success", state, onEvent });
    expect(events).toHaveLength(0);
  });

  test("omitting onEvent still updates state without emitting", async () => {
    // `onEvent` is optional in `CircuitBreakerArgs`. When omitted the plugin
    // must still mutate the state container correctly — the only missing
    // side effect is the transition notification.
    const state = makeState();

    for (let i = 0; i < 3; i++) {
      await runCircuit({ key: "k", outcome: "failure", state });
    }
    expect(state.consecutiveCompactionFailures).toBe(3);
    expect(state.compactionCircuitOpenUntil).not.toBeNull();

    await runCircuit({ key: "k", outcome: "success", state });
    expect(state.consecutiveCompactionFailures).toBe(0);
    expect(state.compactionCircuitOpenUntil).toBeNull();
  });

  test("pipeline runner applies registered middleware in registration order", async () => {
    // A second plugin registered after the default can observe args/result
    // around the default's behavior. This proves the pipeline composes both
    // middlewares rather than short-circuiting on the default alone.
    const seen: string[] = [];
    registerPlugin({
      manifest: {
        name: "observer",
        version: "0.0.1",
        requires: { pluginRuntime: "v1", circuitBreakerApi: "v1" },
      },
      middleware: {
        circuitBreaker: async (args, next) => {
          seen.push(`before:${args.outcome ?? "query"}`);
          const res = await next(args);
          seen.push(`after:${res.open ? "open" : "closed"}`);
          return res;
        },
      },
    });

    const state = makeState();
    await runCircuit({ key: "k", outcome: "failure", state });
    await runCircuit({ key: "k", outcome: "failure", state });
    await runCircuit({ key: "k", outcome: "failure", state });

    expect(seen).toEqual([
      "before:failure",
      "after:closed",
      "before:failure",
      "after:closed",
      "before:failure",
      "after:open",
    ]);
  });
});
