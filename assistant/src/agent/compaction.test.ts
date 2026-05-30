/**
 * Tests for {@link invokeCompactionPipeline}.
 *
 * The helper is a thin wrapper around `runPipeline("compaction", ...)`.
 * What we verify here is the *consolidation contract* that every site in
 * `daemon/conversation-agent-loop.ts` previously implemented inline:
 *
 *   - Happy path returns `{ ok: true, result }` with the terminal's
 *     output unchanged.
 *   - `PluginTimeoutError` is caught and returned as `{ ok: false,
 *     reason: "timeout", error }` — the caller picks its own fallback.
 *   - On timeout, `trackCompactionOutcome(ctx, true, onEvent)` MUST fire
 *     so the 3-strike compaction circuit breaker keeps its accounting.
 *   - Non-timeout errors bubble untouched.
 *
 * The deeper end-to-end coverage (`PluginTimeoutError` actually being
 * thrown by `runPipeline`, abort signal linking, breaker state
 * transitions) already lives in
 * `__tests__/compaction-timeout-recovery.test.ts`; we don't re-prove that
 * here. These tests guard the helper's *interface*.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import pino from "pino";

import type { AgentLoopConversationContext } from "../daemon/conversation-agent-loop.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { defaultCircuitBreakerPlugin } from "../plugins/defaults/circuit-breaker.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import {
  type CompactionArgs,
  type CompactionResult,
  type Middleware,
  PluginTimeoutError,
} from "../plugins/types.js";
import { invokeCompactionPipeline } from "./compaction.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Minimal stand-in for {@link AgentLoopConversationContext}.
 *
 * The helper reads only the fields that flow into either
 * `buildPluginTurnContext` (turn metadata + the manager handle) or
 * `trackCompactionOutcome` (the breaker counters). Anything else stays
 * undefined.
 */
function makeFakeCtx(): AgentLoopConversationContext {
  const trust: TrustContext = {
    sourceChannel: "vellum",
    trustClass: "guardian",
  };
  return {
    conversationId: "conv-helper-test",
    consecutiveCompactionFailures: 0,
    compactionCircuitOpenUntil: null,
    currentRequestId: "req-helper-test",
    currentTurnTrustContext: trust,
    trustContext: trust,
    turnCount: 0,
    // The helper threads the manager through `buildPluginTurnContext`
    // and into the terminal. Tests don't exercise the terminal, so a
    // typed stub is enough.
    contextWindowManager: {
      maybeCompact: async () => ({ compacted: false }) as unknown,
    } as AgentLoopConversationContext["contextWindowManager"],
  } as unknown as AgentLoopConversationContext;
}

function collectEvents(): {
  events: ServerMessage[];
  onEvent: (msg: ServerMessage) => void;
} {
  const events: ServerMessage[] = [];
  return { events, onEvent: (msg) => events.push(msg) };
}

const silentLogger = pino({ level: "silent" });

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("invokeCompactionPipeline", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultCircuitBreakerPlugin);
  });

  afterEach(() => {
    resetPluginRegistryForTests();
  });

  test("returns { ok: true, result } when no middleware throws", async () => {
    const fakeResult = {
      compacted: false,
      messages: [],
      summaryFailed: undefined,
    } as unknown as CompactionResult;

    // Register a pass-through that yields a known result. The helper
    // routes through `runPipeline → middlewares → defaultCompactionTerminal`,
    // so this middleware returns the result directly without calling
    // `next` — short-circuiting the real terminal.
    const passthrough: Middleware<CompactionArgs, CompactionResult> = async (
      _args,
      _next,
    ) => fakeResult;

    registerPlugin({
      manifest: { name: "test-passthrough-compaction", version: "0.0.1" },
      middleware: { compaction: passthrough },
    });

    const ctx = makeFakeCtx();
    const { onEvent, events } = collectEvents();
    const controller = new AbortController();

    const outcome = await invokeCompactionPipeline({
      ctx,
      requestId: "req-helper-test",
      phase: "start-of-turn-compaction",
      messages: [],
      signal: controller.signal,
      options: {},
      onEvent,
      logger: silentLogger,
      timeoutMs: 50,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe(fakeResult as never);
    }
    // No timeout → no circuit-breaker side effect → no events.
    expect(events).toHaveLength(0);
    expect(ctx.consecutiveCompactionFailures).toBe(0);
  });

  test("returns { ok: false, reason: 'timeout' } and records breaker failure when pipeline times out", async () => {
    // Hang forever — the pipeline runner's timer will fire and throw
    // `PluginTimeoutError`. The helper catches it and converts to the
    // discriminated `ok: false` branch.
    const hang: Middleware<CompactionArgs, CompactionResult> = async (
      _args,
      _next,
    ) =>
      new Promise<CompactionResult>(() => {
        // intentionally never resolves
      });

    registerPlugin({
      manifest: { name: "test-hang-compaction", version: "0.0.1" },
      middleware: { compaction: hang },
    });

    const ctx = makeFakeCtx();
    const { onEvent, events } = collectEvents();
    const controller = new AbortController();

    const outcome = await invokeCompactionPipeline({
      ctx,
      requestId: "req-helper-test",
      phase: "mid-loop-compact",
      messages: [],
      signal: controller.signal,
      options: {},
      onEvent,
      logger: silentLogger,
      // Tight timeout to keep the test snappy.
      timeoutMs: 20,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("timeout");
      expect(outcome.error).toBeInstanceOf(PluginTimeoutError);
      expect(outcome.error.pipeline).toBe("compaction");
    }
    // Single timeout: counter ticks to 1, breaker stays closed (trips at 3).
    expect(ctx.consecutiveCompactionFailures).toBe(1);
    expect(ctx.compactionCircuitOpenUntil).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("non-timeout errors bubble untouched", async () => {
    const explode: Middleware<CompactionArgs, CompactionResult> = async () => {
      throw new Error("boom");
    };

    registerPlugin({
      manifest: { name: "test-explode-compaction", version: "0.0.1" },
      middleware: { compaction: explode },
    });

    const ctx = makeFakeCtx();
    const { onEvent } = collectEvents();
    const controller = new AbortController();

    let caught: unknown;
    try {
      await invokeCompactionPipeline({
        ctx,
        requestId: "req-helper-test",
        phase: "emergency-compaction",
        messages: [],
        signal: controller.signal,
        options: {},
        onEvent,
        logger: silentLogger,
        timeoutMs: 50,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("boom");
    // Non-timeout errors must NOT touch the breaker — only PluginTimeoutError
    // is the helper's responsibility. The orchestrator's normal error path
    // owns everything else.
    expect(ctx.consecutiveCompactionFailures).toBe(0);
  });

  test("three consecutive timeouts trip the compaction breaker via the helper's side effect", async () => {
    // Verifies the consolidation contract: the helper's `trackCompactionOutcome`
    // call is wired correctly enough that the canonical 3-strike trip still
    // happens when every invocation times out.
    const hang: Middleware<CompactionArgs, CompactionResult> = async (
      _args,
      _next,
    ) =>
      new Promise<CompactionResult>(() => {
        // intentionally never resolves
      });

    registerPlugin({
      manifest: { name: "test-hang-3x-compaction", version: "0.0.1" },
      middleware: { compaction: hang },
    });

    const ctx = makeFakeCtx();
    const { onEvent, events } = collectEvents();
    const controller = new AbortController();

    for (let i = 0; i < 3; i += 1) {
      const outcome = await invokeCompactionPipeline({
        ctx,
        requestId: "req-helper-test",
        phase: "start-of-turn-compaction",
        messages: [],
        signal: controller.signal,
        options: {},
        onEvent,
        logger: silentLogger,
        timeoutMs: 20,
      });
      expect(outcome.ok).toBe(false);
    }

    expect(ctx.consecutiveCompactionFailures).toBe(3);
    expect(ctx.compactionCircuitOpenUntil).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "compaction_circuit_open",
      conversationId: ctx.conversationId,
      reason: "3_consecutive_failures",
    });
  });
});
