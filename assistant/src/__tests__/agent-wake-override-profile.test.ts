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
 *   3. With both set, `RetryProvider.normalizeSendMessageOptions` actually
 *      invokes the resolver and replaces workspace defaults with the
 *      pinned-profile values.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mockOverrideProfile: string | undefined = undefined;

mock.module("../memory/conversation-crud.js", () => ({
  getConversationOverrideProfile: (_id: string) => mockOverrideProfile,
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

import type { AgentEvent } from "../agent/loop.js";
import { LLMSchema } from "../config/schemas/llm.js";
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
  type WakeTarget,
} from "../runtime/agent-wake.js";

interface RunArgs {
  messages: Message[];
  signal: AbortSignal | undefined;
  requestId: string | undefined;
  onCheckpoint: unknown;
  callSite: unknown;
  turnContext: unknown;
  overrideProfile: string | undefined;
}

function makeTarget(): {
  target: WakeTarget;
  runArgs: RunArgs[];
} {
  const runArgs: RunArgs[] = [];
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  let processing = false;

  const target: WakeTarget = {
    conversationId: "conv-wake-override",
    agentLoop: {
      run: (async (
        messages: Message[],
        _onEvent: (event: AgentEvent) => void | Promise<void>,
        signal?: AbortSignal,
        requestId?: string,
        onCheckpoint?: unknown,
        callSite?: unknown,
        turnContext?: unknown,
        overrideProfile?: string,
      ) => {
        runArgs.push({
          messages: [...messages],
          signal,
          requestId,
          onCheckpoint,
          callSite,
          turnContext,
          overrideProfile,
        });
        // Return the input verbatim → silent no-op (no assistant tail).
        return messages;
      }) as WakeTarget["agentLoop"]["run"],
    },
    getMessages: () => history,
    pushMessage: (msg) => {
      history.push(msg);
    },
    emitAgentEvent: () => {},
    isProcessing: () => processing,
    markProcessing: (on) => {
      processing = on;
    },
    persistTailMessage: async () => {},
  };
  return { target, runArgs };
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
    // The 8th positional argument (after messages, onEvent, signal,
    // requestId, onCheckpoint, callSite, turnContext) is overrideProfile.
    expect(runArgs[0]!.overrideProfile).toBe("frontier");
    // The 6th positional argument is callSite. Wakes resume a user-facing
    // conversation, so route through the same `mainAgent` call site as a
    // normal user turn — without it the resolver and routing layers would
    // short-circuit and silently drop both the call-site config and the
    // pinned override profile.
    expect(runArgs[0]!.callSite).toBe("mainAgent");
    // Sanity: the wake-source tag still propagates as requestId.
    expect(runArgs[0]!.requestId).toBe("wake:scheduler");
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
    expect(runArgs[0]!.overrideProfile).toBeUndefined();
    // Even without an override profile, we still need callSite="mainAgent"
    // so the resolver picks up `llm.callSites.mainAgent` config (model,
    // maxTokens, effort, etc.). Otherwise the wake silently runs under
    // workspace defaults regardless of any per-call-site configuration.
    expect(runArgs[0]!.callSite).toBe("mainAgent");
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
      async sendMessage(_messages, _tools, _systemPrompt, options) {
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
      undefined,
      undefined,
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
