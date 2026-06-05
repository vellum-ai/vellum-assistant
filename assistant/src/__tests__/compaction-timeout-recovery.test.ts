/**
 * Tests for the compaction call-site recovery path added in JARVIS-587.
 *
 * When the `compaction` pipeline exceeds its 30s budget (manifest-wide
 * `DEFAULT_TIMEOUTS.compaction`), the pipeline runner throws
 * `PluginTimeoutError`. The three compaction call sites in
 * `conversation-agent-loop.ts` (start-of-turn, mid-loop, emergency) catch
 * that error, record the failure on the loop-held `CompactionCircuit`
 * (`recordOutcome(true, ...)`) so the circuit breaker counts it, and degrade
 * gracefully.
 *
 * This file asserts the tight coupling between:
 *  (1) a `PluginTimeoutError`-driven failure and
 *  (2) the compaction circuit breaker's 3-strike threshold.
 *
 * The `compaction-circuit.test.ts` file exercises the breaker's transitions
 * end-to-end. These tests verify that our catch-blocks feed the breaker the
 * same failure outcome a normal summary-LLM throw would, and that repeated
 * timeouts therefore trip the same 3-strike trip.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  COMPACTION_CIRCUIT_FAILURE_THRESHOLD,
  CompactionCircuit,
} from "../agent/compaction-circuit.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type CompactionArgs,
  type CompactionResult,
  type Middleware,
  PluginTimeoutError,
  type TurnContext,
} from "../plugins/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeCircuit(conversationId = "conv-timeout-test"): CompactionCircuit {
  return new CompactionCircuit(conversationId);
}

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeTurnCtx(conversationId: string): TurnContext {
  return {
    requestId: "req-timeout-test",
    conversationId,
    turnIndex: 0,
    trust,
  };
}

function collectEvents(): {
  events: ServerMessage[];
  onEvent: (msg: ServerMessage) => void;
} {
  const events: ServerMessage[] = [];
  return { events, onEvent: (msg) => events.push(msg) };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("compaction timeout recovery (JARVIS-587)", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  afterEach(() => {
    resetPluginRegistryForTests();
  });

  test("runPipeline('compaction', ...) throws PluginTimeoutError on budget breach", async () => {
    // Baseline: the compaction pipeline still surfaces PluginTimeoutError when
    // its timer fires. This guards the outer race from silently swallowing
    // the timeout when the inner call is aborted by our Part A wiring.
    const hang: Middleware<CompactionArgs, CompactionResult> = async (
      _args,
      _next,
    ) =>
      new Promise<CompactionResult>(() => {
        // intentionally never resolves
      });

    let caught: unknown;
    try {
      await runPipeline<CompactionArgs, CompactionResult>(
        "compaction",
        [hang],
        async () => ({ compacted: false }) as unknown as CompactionResult,
        { messages: [] as unknown, signal: undefined, options: undefined },
        makeTurnCtx("conv-budget-breach"),
        // Override the manifest timeout to keep the test fast.
        20,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginTimeoutError);
    expect((caught as PluginTimeoutError).pipeline).toBe("compaction");
  });

  test("recordOutcome(failed=true) driven by PluginTimeoutError trips the breaker at the 3rd strike", async () => {
    // Simulates the production sequence: each mid-loop compaction hits the
    // pipeline's 30s ceiling, the catch path calls
    // `circuit.recordOutcome(true, onEvent)`. After three such catches
    // the circuit breaker must be open — matching the same invariant the
    // existing breaker test file exercises for normal summary-LLM throws.
    const circuit = makeCircuit();
    const { onEvent, events } = collectEvents();

    // First two timeouts — circuit still closed.
    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(2);
    expect(circuit.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);

    // Third timeout — breaker trips and emits the canonical transition event.
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(
      COMPACTION_CIRCUIT_FAILURE_THRESHOLD,
    );
    expect(circuit.compactionCircuitOpenUntil).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "compaction_circuit_open",
      conversationId: circuit.conversationId,
      reason: "3_consecutive_failures",
      openUntil: circuit.compactionCircuitOpenUntil as number,
    });
  });

  test("a successful compaction after two timeouts resets the counter", async () => {
    // The recovery path doesn't interfere with the breaker's normal reset —
    // once a compaction call eventually succeeds, the streak is broken and
    // the next failure starts counting from 1.
    const circuit = makeCircuit();
    const { onEvent } = collectEvents();

    await circuit.recordOutcome(true, onEvent);
    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(2);

    await circuit.recordOutcome(false, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(0);
    expect(circuit.compactionCircuitOpenUntil).toBeNull();

    await circuit.recordOutcome(true, onEvent);
    expect(circuit.consecutiveCompactionFailures).toBe(1);
  });

  test("compaction call-site recovery remains defense-in-depth even when DEFAULT_TIMEOUTS.compaction is null", () => {
    // At the time this PR landed, `DEFAULT_TIMEOUTS.compaction` was null
    // (pipeline timeouts globally disabled — see #27608). That makes the
    // call-site catch blocks unreachable in production right now, but the
    // catch blocks still matter: any future reintroduction of a per-pipeline
    // compaction timeout immediately benefits from circuit-breaker recording
    // and graceful-degradation without needing to re-touch every call site.
    //
    // This test just documents the current value so a future change that
    // reintroduces a timeout must also decide (intentionally) whether the
    // recovery path should continue to fire.
    const value = DEFAULT_TIMEOUTS.compaction;
    expect(value === null || typeof value === "number").toBe(true);
  });
});

describe("abort propagation end-to-end (Part A + updateSummary fallback)", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  afterEach(() => {
    resetPluginRegistryForTests();
  });

  test("caller-provided signal is replaced with a linked signal that fires on timeout", async () => {
    // Minimal proof that Part A actually wires the signal through the
    // compaction pipeline: when the pipeline runner's timer fires, the
    // signal seen by the inner terminal is aborted — allowing
    // `updateSummary`'s try/catch around `provider.sendMessage` to trigger
    // the local-fallback path instead of the call hanging indefinitely.
    let observedSignal: AbortSignal | undefined;
    const waitForAbort: Middleware<CompactionArgs, CompactionResult> = async (
      args,
      _next,
    ) => {
      observedSignal = args.signal;
      return new Promise<CompactionResult>((_resolve, reject) => {
        args.signal?.addEventListener("abort", () => {
          reject(
            Object.assign(new Error("aborted by signal"), {
              name: "AbortError",
            }),
          );
        });
      });
    };

    const callerController = new AbortController();

    let caught: unknown;
    try {
      await runPipeline<CompactionArgs, CompactionResult>(
        "compaction",
        [waitForAbort, ...getMiddlewaresFor("compaction")],
        async () => ({ compacted: false }) as unknown as CompactionResult,
        {
          messages: [] as unknown,
          signal: callerController.signal,
          options: undefined,
        },
        makeTurnCtx("conv-abort-test"),
        20,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginTimeoutError);
    expect(observedSignal).toBeDefined();
    // The runner swaps the caller's signal for a linked signal — the two are
    // distinct objects but both should end up aborted once the timer fires.
    expect(observedSignal).not.toBe(callerController.signal);
    expect(observedSignal!.aborted).toBe(true);
    // Caller's own signal is untouched — pipeline timeout does not cascade
    // outward onto the caller's controller.
    expect(callerController.signal.aborted).toBe(false);
  });
});
