/**
 * Regression test for the wake-driven override-profile gap.
 *
 * `wakeAgentForOpportunity` invokes `agentLoop.run(...)` directly, bypassing
 * `runAgentLoopImpl`. Without an explicit row read, scheduled-task wakes and
 * other opportunity wakes targeting a user conversation with a pinned profile
 * would execute under workspace defaults — silently violating the user's
 * pinned preference.
 *
 * The wake also has to pass `callSite: "mainAgent"` explicitly. The agent loop
 * threads `callSite` and `overrideProfile` onto the per-call provider config,
 * but `RetryProvider.normalizeSendMessageOptions` only invokes
 * `resolveCallSiteConfig` when `config.callSite !== undefined` and
 * `CallSiteRoutingProvider.selectProvider` short-circuits to the default
 * provider when `callSite` is absent. So a wake that only set
 * `overrideProfile` (with `callSite: undefined`) would still execute under
 * workspace defaults — the pinned profile would be silently dropped.
 *
 * This file pins `getConversationOverrideProfile` to a fixed profile name and
 * asserts that:
 *   1. The wake forwards `overrideProfile` to `agentLoop.run`.
 *   2. The wake forwards `callSite: "mainAgent"` to `agentLoop.run`.
 *   3. The wake resolves and forwards the effective max input token budget.
 *   4. With both routing keys set, `RetryProvider.normalizeSendMessageOptions` actually
 *      invokes the resolver and replaces workspace defaults with the
 *      pinned-profile values.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockOverrideProfile: string | undefined = undefined;

mock.module("../memory/conversation-crud.js", () => ({
  getConversationOverrideProfile: (_id: string) => mockOverrideProfile,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

// Mutable stub for `getConfig().llm` consumed by `RetryProvider`'s
// resolver path in the integration-style assertion below. Defined ahead of
// import so the module-level `getConfig()` reference inside `retry.ts`
// closes over our mutable holder.
let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
    services: { inference: { mode: "your-own" } },
  }),
}));

import type { AgentLoopRunOptions } from "../agent/loop.js";
import { LLMSchema } from "../config/schemas/llm.js";
import type { Conversation } from "../daemon/conversation.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import {
  __resetWakeChainForTests,
  wakeAgentForOpportunity,
} from "../runtime/agent-wake.js";

interface RunArgs {
  messages: Message[];
  options: AgentLoopRunOptions | undefined;
}

function makeTarget(): {
  target: Conversation;
  runArgs: RunArgs[];
} {
  const runArgs: RunArgs[] = [];
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  let processing = false;

  const target = {
    conversationId: "conv-wake-override",
    agentLoop: {
      run: async (options: AgentLoopRunOptions) => {
        runArgs.push({
          messages: [...options.messages],
          options,
        });
        // Return the input verbatim → silent no-op (no assistant tail).
        // Wake never yields at a checkpoint, so the pause-reason is null.
        return { history: options.messages, exitReason: null };
      },
    },
    messages,
    getMessages: () => messages,
    isProcessing: () => processing,
    setProcessing: (on: boolean) => {
      processing = on;
    },
    setTrustContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    drainQueue: async () => {},
    // Pre-run auto-compaction gate — no-op for these tests.
    maybeCompact: async () => null,
  };
  return { target: target as unknown as Conversation, runArgs };
}

beforeEach(() => {
  __resetWakeChainForTests();
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
});

afterEach(() => {
  mockOverrideProfile = undefined;
});

describe("wakeAgentForOpportunity — overrideProfile forwarding", () => {
  test("forwards the conversation's pinned overrideProfile + mainAgent callSite to agentLoop.run", async () => {
    mockOverrideProfile = "frontier";
    mockLlmConfig = LLMSchema.parse({
      default: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 64000,
        contextWindow: { maxInputTokens: 200000 },
      },
      profiles: {
        frontier: {
          contextWindow: { maxInputTokens: 150000 },
        },
      },
      callSites: {
        mainAgent: {},
      },
    }) as Record<string, unknown>;
    const { target, runArgs } = makeTarget();

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );

    expect(result.invoked).toBe(true);
    expect(runArgs).toHaveLength(1);
    expect(runArgs[0]!.options?.overrideProfile).toBe("frontier");
    // Wakes resume a user-facing conversation, so route through the same
    // `mainAgent` call site as a normal user turn — without it the resolver
    // and routing layers would short-circuit and silently drop both the
    // call-site config and the pinned override profile.
    expect(runArgs[0]!.options?.callSite).toBe("mainAgent");
    expect(runArgs[0]!.options?.resolveContextWindow?.().maxInputTokens).toBe(
      150000,
    );
    // Sanity: the wake-source tag still propagates as requestId.
    expect(runArgs[0]!.options?.requestId).toBe("wake:scheduler");
  });

  test("forceOverrideProfile replaces the pinned-profile lookup and forwards the force flag to agentLoop.run", async () => {
    // The conversation's own pinned profile must be ignored — the caller's
    // forced profile (e.g. a fork-based retrospective matching the source
    // conversation) takes its place AND floats above the call-site layers
    // via the resolver's `forceOverrideProfile` escape hatch.
    mockOverrideProfile = "pinned-ignored";
    mockLlmConfig = LLMSchema.parse({
      default: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 64000,
        contextWindow: { maxInputTokens: 200000 },
      },
      profiles: {
        forced: {
          contextWindow: { maxInputTokens: 120000 },
        },
      },
      callSites: {
        memoryRetrospective: { contextWindow: { maxInputTokens: 180000 } },
      },
    }) as Record<string, unknown>;
    const { target, runArgs } = makeTarget();

    const result = await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "memory-retrospective",
        callSite: "memoryRetrospective",
        forceOverrideProfile: "forced",
      },
      { resolveTarget: async () => target },
    );

    expect(result.invoked).toBe(true);
    expect(runArgs).toHaveLength(1);
    expect(runArgs[0]!.options?.overrideProfile).toBe("forced");
    expect(runArgs[0]!.options?.forceOverrideProfile).toBe(true);
    expect(runArgs[0]!.options?.callSite).toBe("memoryRetrospective");
    // The effective context window resolves under the FORCED profile, above
    // the explicit call-site override (120k beats the call site's 180k).
    expect(runArgs[0]!.options?.resolveContextWindow?.().maxInputTokens).toBe(
      120000,
    );
  });

  test("without forceOverrideProfile the wake never sets the force flag", async () => {
    mockOverrideProfile = "frontier";
    mockLlmConfig = LLMSchema.parse({
      default: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 64000,
        contextWindow: { maxInputTokens: 200000 },
      },
      profiles: { frontier: {} },
      callSites: { mainAgent: {} },
    }) as Record<string, unknown>;
    const { target, runArgs } = makeTarget();

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "scheduler",
      },
      { resolveTarget: async () => target },
    );

    expect(runArgs).toHaveLength(1);
    expect(runArgs[0]!.options?.overrideProfile).toBe("frontier");
    expect(runArgs[0]!.options?.forceOverrideProfile).toBe(false);
  });

  test("passes undefined overrideProfile when the conversation has no pinned profile, but still forwards mainAgent callSite", async () => {
    mockOverrideProfile = undefined;
    const { target, runArgs } = makeTarget();

    await wakeAgentForOpportunity(
      {
        conversationId: target.conversationId,
        hint: "test hint",
        source: "unit-test",
      },
      { resolveTarget: async () => target },
    );

    expect(runArgs).toHaveLength(1);
    expect(runArgs[0]!.options?.overrideProfile).toBeUndefined();
    // Even without an override profile, we still need callSite="mainAgent"
    // so the resolver picks up `llm.callSites.mainAgent` config (model,
    // maxTokens, effort, etc.). Otherwise the wake silently runs under
    // workspace defaults regardless of any per-call-site configuration.
    expect(runArgs[0]!.options?.callSite).toBe("mainAgent");
    expect(
      runArgs[0]!.options?.resolveContextWindow?.().maxInputTokens,
    ).toBeGreaterThan(0);
  });
});

describe("wakeAgentForOpportunity — resolver actually engages", () => {
  // The unit tests above only assert positional argument forwarding. They
  // do not exercise the real provider chain, which is exactly the gap that
  // let the original bug ship: the wake forwarded `overrideProfile` but
  // passed `callSite: undefined`, and `RetryProvider.normalizeSendMessageOptions`
  // only invokes `resolveCallSiteConfig` when `config.callSite !== undefined`.
  // This test wires the same `(callSite, overrideProfile)` pair the wake now
  // produces into a real `RetryProvider.sendMessage` call to confirm the
  // resolver fires and the pinned-profile values replace workspace defaults.

  function makeProvider(
    name: string,
    onCall: (options: SendMessageOptions | undefined) => void,
  ): Provider {
    return {
      name,
      async sendMessage(_messages: Message[], options?: SendMessageOptions) {
        onCall(options);
        const response: ProviderResponse = {
          content: [{ type: "text", text: "ok" }],
          model: "stub",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
        return response;
      },
    };
  }

  test("with callSite='mainAgent' + overrideProfile, RetryProvider resolves the pinned-profile model/maxTokens", async () => {
    // Workspace defaults intentionally differ from the pinned-profile values
    // so we can detect whether the resolver engaged. If `callSite` were
    // undefined (the original bug), the retry layer would skip the resolver
    // entirely and the downstream provider would see only the wire defaults.
    mockLlmConfig = LLMSchema.parse({
      default: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 64000,
      },
      profiles: {
        frontier: {
          model: "claude-opus-4-7",
          maxTokens: 32000,
        },
      },
      callSites: {
        mainAgent: {},
      },
    }) as Record<string, unknown>;

    let seen: SendMessageOptions | undefined;
    const wrapped = new RetryProvider(
      makeProvider("anthropic", (options) => {
        seen = options;
      }),
    );

    // Mirror exactly what `agentLoop.run` puts on `providerConfig` when
    // `callSite` and `overrideProfile` are both set (see `agent/loop.ts`).
    await wrapped.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      { config: { callSite: "mainAgent", overrideProfile: "frontier" } },
    );

    const config = seen?.config as Record<string, unknown>;
    // Resolver engaged → pinned-profile values applied.
    expect(config.model).toBe("claude-opus-4-7");
    expect(config.max_tokens).toBe(32000);
    // Both routing keys are stripped before delegating downstream so they
    // never leak into provider request bodies.
    expect(config.callSite).toBeUndefined();
    expect(config.overrideProfile).toBeUndefined();
  });
});
