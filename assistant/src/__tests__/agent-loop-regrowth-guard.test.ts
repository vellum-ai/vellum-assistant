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
import type { TrustContext } from "../daemon/trust-context.js";
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

const CONVERSATION_ID = "regrowth-conversation";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Hello there, this is the turn body." }],
};

/**
 * Register a per-conversation manager whose `maybeCompact` returns a real
 * (compacted) history so the loop records the post-compaction watermark, and
 * surface a `setWatermark` knob to seed the regrowth state before the run.
 */
function installManager(): { trust: TrustContext } {
  createContextWindowManager({
    provider: { name: "mock-provider" } as unknown as Provider,
    systemPrompt: "system",
    config: {} as unknown as ContextWindowConfig,
    conversationId: CONVERSATION_ID,
  });
  const manager = getContextWindowManager(CONVERSATION_ID);
  if (manager) {
    manager.maybeCompact = (async () => ({
      messages: [userMessage],
      compacted: true,
      exhausted: false,
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
