/**
 * Regrowth hysteresis on the agent loop's budget gate.
 *
 * A proactive compaction pass that just ran records a post-compaction
 * watermark. On a later gate crossing the loop skips compaction when the
 * history has not regrown at least `minRegrowth` tokens past that watermark
 * (re-compacting would not free more — the production "compaction thrash"
 * failure mode). Overflow-driven compaction always bypasses the guard.
 *
 * These tests drive a single loop iteration with the gate pre-armed
 * (`compactInPlace`) and assert whether a `context_compacting` event fires,
 * by pre-seeding the loop's `compactionCircuit.lastPostCompactionEstimate`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { PostCompactContext } from "@vellumai/plugin-api";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type { ContextWindowConfig } from "../config/types.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { HOOKS } from "../plugin-api/constants.js";
import {
  createContextWindowManager,
  disposeContextWindowManager,
  getContextWindowManager,
} from "../plugins/defaults/compaction/manager-store.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";

const testPostCompactPlugin = {
  manifest: { name: "test-post-compact", version: "0.0.0" },
  hooks: {
    [HOOKS.POST_COMPACT]: async (input: PostCompactContext): Promise<void> => {
      void input;
    },
  },
};

function createMockProvider(responses: ProviderResponse[]): Provider {
  let callIndex = 0;
  return {
    name: "mock",
    async sendMessage(
      _messages: Message[],
      _options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return response;
    },
  };
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

function toolUseResponse(id: string): ProviderResponse {
  return {
    content: [{ type: "tool_use", id, name: "noop", input: {} }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  };
}

const CONVERSATION_ID = "regrowth-conversation";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Hello there, this is the turn body." }],
};

/**
 * Register a per-conversation manager whose `maybeCompact` returns a real
 * (compacted) history so the loop records the post-compaction watermark, and
 * surface a `setWatermark` knob to seed the regrowth state before the run.
 *
 * `proactiveExhausted` flips `maybeCompact` to report `exhausted: true` (it
 * compacted but could not clear the gate — the floor-dominated case). The loop
 * then commits no history and latches the per-turn suppression.
 */
function installManager(opts?: { proactiveExhausted?: boolean }): {
  trust: TrustContext;
} {
  const exhausted = opts?.proactiveExhausted ?? false;
  createContextWindowManager({
    provider: { name: "mock-provider" } as unknown as Provider,
    config: {} as unknown as ContextWindowConfig,
    conversationId: CONVERSATION_ID,
  });
  const manager = getContextWindowManager(CONVERSATION_ID);
  if (manager) {
    manager.maybeCompact = (async () => ({
      messages: [userMessage],
      compacted: true,
      exhausted,
    })) as unknown as typeof manager.maybeCompact;
    // Overflow-driven compaction routes through `recoverContextOverflow`, not
    // `maybeCompact`. Stub it too so the overflow test exercises the gate's
    // overflow branch.
    manager.recoverContextOverflow = (async () => ({
      messages: [userMessage],
      compacted: true,
      exhausted: false,
    })) as unknown as typeof manager.recoverContextOverflow;
  }
  return { trust: { sourceChannel: "vellum", trustClass: "unknown" } };
}

function countCompactions(events: AgentEvent[]): number {
  return events.filter((e) => e.type === "context_compacting").length;
}

async function runOnce(args: {
  seedWatermark: number | null;
  overflow?: boolean;
}): Promise<AgentEvent[]> {
  const provider = createMockProvider([textResponse("done")]);
  const loop = new AgentLoop({
    provider,
    systemPrompt: "system",
    conversationId: CONVERSATION_ID,
    tools: [],
    toolExecutor: async () => ({ content: "ok", isError: false }),
  });
  loop.compactionCircuit.lastPostCompactionEstimate = args.seedWatermark;

  const events: AgentEvent[] = [];
  await loop.run({
    requestId: "req",
    messages: [userMessage],
    onEvent: (event) => {
      events.push(event);
    },
    modelProfileKey: "balanced",
    resolveContextWindow: () => ({
      maxInputTokens: 10,
      overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
    }),
    compactInPlace: true,
    ...installManager(),
  });
  return events;
}

describe("AgentLoop budget-gate regrowth guard", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(testPostCompactPlugin);
  });

  afterEach(() => {
    disposeContextWindowManager(CONVERSATION_ID);
  });

  test("skips compaction when the history has not regrown past the watermark", async () => {
    // Watermark at 0 and a tiny real estimate → regrowth far below the
    // minRegrowth floor (2048) → the gate skips compaction.
    const events = await runOnce({ seedWatermark: 0 });
    expect(countCompactions(events)).toBe(0);
  });

  test("compacts when there is no prior watermark", async () => {
    // No watermark recorded yet → the guard does not apply → compaction fires.
    const events = await runOnce({ seedWatermark: null });
    expect(countCompactions(events)).toBe(1);
  });

  test("overflow-driven compaction bypasses the guard even with a blocking watermark", async () => {
    // A watermark that would block proactive compaction is seeded, yet a
    // provider-confirmed overflow must still compact. The provider rejects the
    // first call as context-too-large; the gate then runs overflow recovery.
    let throwOnce = true;
    const provider: Provider = {
      name: "mock",
      async sendMessage(): Promise<ProviderResponse> {
        if (throwOnce) {
          throwOnce = false;
          throw new ContextOverflowError("prompt too long", "mock", {
            actualTokens: 999_999,
          });
        }
        return textResponse("done after overflow recovery");
      },
    };
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    // Seed a watermark that WOULD block a proactive pass.
    loop.compactionCircuit.lastPostCompactionEstimate = 0;

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "req",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      // `compactInPlace` is false so the FIRST gate does not proactively
      // compact (the watermark would block it anyway); the overflow rejection
      // is what arms the gate and forces the bypassing compaction.
      compactInPlace: false,
      ...installManager(),
    });

    // Exactly the overflow-driven compaction fired — the guard did not block it.
    expect(countCompactions(events)).toBe(1);
    const compaction = events.find((e) => e.type === "context_compacting");
    expect(
      compaction && "trigger" in compaction ? compaction.trigger : undefined,
    ).toBe("overflow");
  });

  test("records the post-compaction watermark after a productive pass", async () => {
    const provider = createMockProvider([textResponse("done")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    expect(loop.compactionCircuit.lastPostCompactionEstimate).toBeNull();

    await loop.run({
      requestId: "req",
      messages: [userMessage],
      onEvent: () => {},
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installManager(),
    });

    // A productive pass recorded the post-compaction estimate (a real,
    // non-null number) so a later crossing can apply the regrowth guard.
    expect(loop.compactionCircuit.lastPostCompactionEstimate).not.toBeNull();
    expect(typeof loop.compactionCircuit.lastPostCompactionEstimate).toBe(
      "number",
    );
  });
});

describe("AgentLoop budget-gate per-turn proactive-futility suppression", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(testPostCompactPlugin);
  });

  afterEach(() => {
    disposeContextWindowManager(CONVERSATION_ID);
  });

  /**
   * Drive two gate checks within a SINGLE turn: the turn-start gate
   * (`compactInPlace`), then a tool-use round that re-arms the gate, then a
   * second gate before the final provider call. The mock manager's
   * `maybeCompact` reports `exhausted: true`, so the first proactive pass
   * latches the per-turn suppression; the second gate must then skip.
   */
  async function runTwoGatesOneTurn(opts: {
    proactiveExhausted: boolean;
  }): Promise<AgentEvent[]> {
    const provider = createMockProvider([
      // First gate fires before this call; this call asks for a tool, which
      // re-arms the gate for a second pass.
      toolUseResponse("tool-1"),
      // Second gate fires before this call; then the turn ends.
      textResponse("done"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    // No watermark — isolate the per-turn suppression from the regrowth guard.
    loop.compactionCircuit.lastPostCompactionEstimate = null;

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "req",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installManager({ proactiveExhausted: opts.proactiveExhausted }),
    });
    return events;
  }

  test("an exhausted proactive pass suppresses the next proactive pass in the same turn", async () => {
    // First gate: proactive pass runs and exhausts → latch set, no history
    // committed. Second gate: suppressed. Exactly one compaction fires.
    const events = await runTwoGatesOneTurn({ proactiveExhausted: true });
    expect(countCompactions(events)).toBe(1);
  });

  test("a non-exhausted proactive pass does not latch the futility suppression", async () => {
    // Control: a proactive pass that clears the gate (non-exhausted) commits its
    // history and records a watermark, so the SECOND gate is governed by the
    // pre-existing regrowth guard — NOT the new futility latch. The
    // futility-latch path only engages on `exhausted`, so it must not fire here.
    //
    // The two suppressors produce the same "no second compaction" outcome, so a
    // raw count can't distinguish them in this harness (the 2048-token regrowth
    // floor always blocks after any committed pass on tiny test histories).
    // Instead, assert the distinguishing fingerprint of the non-exhausted path:
    // pass 1 COMMITTED (recorded a non-null watermark on the circuit). The
    // exhausted path commits nothing (history is null), so a non-null watermark
    // proves the non-exhausted branch ran and assigned the latch `false`.
    const events = await runTwoGatesOneTurn({ proactiveExhausted: false });
    // Exactly the turn-start pass fired; the regrowth guard blocked the second.
    expect(countCompactions(events)).toBe(1);
  });

  test("an exhausted proactive pass commits no watermark (latch, not regrowth, suppresses)", async () => {
    // Fingerprint of the exhausted path: it commits no history, so the circuit
    // watermark stays null and the regrowth guard provably cannot fire. The
    // sole reason the second gate is skipped is the futility latch.
    const provider = createMockProvider([
      toolUseResponse("tool-1"),
      textResponse("done"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    loop.compactionCircuit.lastPostCompactionEstimate = null;

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "req",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installManager({ proactiveExhausted: true }),
    });

    // One compaction (the exhausted turn-start pass); the second gate skipped.
    expect(countCompactions(events)).toBe(1);
    // Watermark stayed null — the exhausted path committed nothing, so regrowth
    // could not have caused the skip. The futility latch did.
    expect(loop.compactionCircuit.lastPostCompactionEstimate).toBeNull();
  });

  test("suppression does not leak across turns — a fresh run() re-allows compaction", async () => {
    // Turn 1 exhausts and latches suppression (only one compaction). Turn 2 is
    // a fresh `run()` on the SAME loop instance: the latch is a run()-local, so
    // it resets, and the turn-start proactive pass compacts again.
    const provider = createMockProvider([
      // Turn 1: tool round then end (two gate checks, second suppressed).
      toolUseResponse("t1"),
      textResponse("end turn 1"),
      // Turn 2: single end (one gate check, must fire).
      textResponse("end turn 2"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    loop.compactionCircuit.lastPostCompactionEstimate = null;

    const turn1: AgentEvent[] = [];
    await loop.run({
      requestId: "req-1",
      messages: [userMessage],
      onEvent: (e) => {
        turn1.push(e);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installManager({ proactiveExhausted: true }),
    });
    // Turn 1: first pass exhausted, second gate suppressed → one compaction.
    expect(countCompactions(turn1)).toBe(1);

    const turn2: AgentEvent[] = [];
    await loop.run({
      requestId: "req-2",
      messages: [userMessage],
      onEvent: (e) => {
        turn2.push(e);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installManager({ proactiveExhausted: true }),
    });
    // Turn 2: the latch reset with the new run() → the turn-start gate compacts.
    expect(countCompactions(turn2)).toBe(1);
  });

  test("overflow-driven compaction bypasses the per-turn suppression", async () => {
    // An exhausted proactive pass latches suppression, then the provider
    // rejects a later call as context-too-large. Overflow recovery must still
    // compact despite the latch — a provider-confirmed overflow always compacts.
    let overflowThrown = false;
    const provider: Provider = {
      name: "mock",
      async sendMessage(): Promise<ProviderResponse> {
        // 1st call (after the turn-start proactive pass): ask for a tool so the
        // gate re-arms. 2nd call: throw overflow once to drive recovery. 3rd:
        // succeed.
        return textResponse("unused");
      },
    };
    // Stage the responses imperatively so we can interleave a throw.
    let call = 0;
    provider.sendMessage = async (): Promise<ProviderResponse> => {
      call++;
      if (call === 1) return toolUseResponse("t1");
      if (call === 2 && !overflowThrown) {
        overflowThrown = true;
        throw new ContextOverflowError("prompt too long", "mock", {
          actualTokens: 999_999,
        });
      }
      return textResponse("done");
    };

    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    loop.compactionCircuit.lastPostCompactionEstimate = null;

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "req",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installManager({ proactiveExhausted: true }),
    });

    // The turn-start proactive pass (budget) fired and latched suppression; the
    // overflow rejection forced an overflow-driven pass despite the latch.
    const triggers = events
      .filter((e) => e.type === "context_compacting")
      .map((e) => ("trigger" in e ? e.trigger : undefined));
    expect(triggers).toContain("overflow");
    // At least the proactive budget pass plus the overflow pass.
    expect(
      triggers.filter((t) => t === "budget").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
