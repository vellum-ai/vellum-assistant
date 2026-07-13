/**
 * Tests for the `system_prompt_changed` event emitted by AgentLoop when the
 * `pre-model-call` hook chain mutates the system prompt.
 *
 * The event fires whenever the post-hook `systemPrompt` differs from the
 * value the loop handed the hook (compared against `providerOptions.systemPrompt`,
 * not the context object — which the hook may mutate in place).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock plugin pipeline. Two modes:
//  - return mode (default): returns `hookResponse` as the hook result.
//  - in-place mode: mutates ctx.systemPrompt directly and returns the same
//    object, simulating a hook that edits the context without returning a
//    new value — the scenario that requires comparing against
//    providerOptions.systemPrompt, not preModelCtx.systemPrompt.
type PreModelCallCtx = {
  conversationId: string;
  callSite: string | null;
  systemPrompt: string | null;
  modelProfile: string | null;
  deferAssistantOutput: boolean;
  logger: unknown;
};
let hookResponse: PreModelCallCtx = {
  conversationId: "test-conv",
  callSite: "mainAgent",
  systemPrompt:
    "BASELINE-PROMPT\n\n<!-- advisor:steering -->\nAPPENDED-FROM-HOOK",
  modelProfile: null,
  deferAssistantOutput: false,
  logger: {},
};
let hookMutatesInPlace = false;
mock.module("../plugins/pipeline.js", () => ({
  runHook: async (
    _hook: unknown,
    ctx: PreModelCallCtx,
  ): Promise<PreModelCallCtx> => {
    if (hookMutatesInPlace) {
      ctx.systemPrompt = hookResponse.systemPrompt;
      return ctx;
    }
    return hookResponse;
  },
}));

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

/** Seed the workspace `llm` config block for real; the loader schema-merges it. */
function setLlmConfig(raw: unknown): void {
  setConfig("llm", raw);
}

beforeEach(() => {
  setLlmConfig({});
  hookMutatesInPlace = false;
  hookResponse = {
    conversationId: "test-conv",
    callSite: "mainAgent",
    systemPrompt:
      "BASELINE-PROMPT\n\n<!-- advisor:steering -->\nAPPENDED-FROM-HOOK",
    modelProfile: null,
    deferAssistantOutput: false,
    logger: {},
  };
});

/**
 * Provider that records the system prompt it sees on every send and short-
 * circuits the turn after one call. We don't need streaming for verifying
 * prompt pushback.
 */
function makeRecordingProvider(): {
  provider: Provider;
  capturedSystemPrompts: () => string[];
} {
  const captured: string[] = [];
  let callCount = 0;
  const provider: Provider = {
    name: "anthropic",
    async sendMessage(
      _messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      if (options?.systemPrompt !== undefined) {
        captured.push(options.systemPrompt);
      }
      callCount += 1;
      return {
        content: [{ type: "text", text: callCount === 1 ? "done" : "..." }],
        model: "mock-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  return { provider, capturedSystemPrompts: () => captured };
}

describe("AgentLoop system_prompt_changed event", () => {
  test("fires when the hook mutates the prompt on mainAgent", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "mock-model" },
    });

    const mutatedPrompt = "BASELINE\n\n<!-- advisor:steering -->";
    hookResponse = {
      conversationId: "test-conv",
      callSite: "mainAgent",
      systemPrompt: mutatedPrompt,
      modelProfile: null,
      deferAssistantOutput: false,
      logger: {},
    };

    const { provider } = makeRecordingProvider();
    const events: AgentEvent[] = [];

    const loop = new AgentLoop({
      provider,
      systemPrompt: "BASELINE",
      config: {},
      conversationId: "test-conv",
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust,
      callSite: "mainAgent",
    });

    const changedEvents = events.filter(
      (e) => e.type === "system_prompt_changed",
    );
    expect(changedEvents).toHaveLength(1);
    expect(changedEvents[0].systemPrompt).toBe(mutatedPrompt);
  });

  test("fires on non-mainAgent call sites too", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "mock-model" },
    });

    hookResponse = {
      conversationId: "test-conv",
      callSite: "subagentSpawn",
      systemPrompt: "MUTATED-BY-HOOK",
      modelProfile: null,
      deferAssistantOutput: false,
      logger: {},
    };

    const { provider } = makeRecordingProvider();
    const events: AgentEvent[] = [];

    const loop = new AgentLoop({
      provider,
      systemPrompt: "BASELINE",
      config: {},
      conversationId: "test-conv",
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust,
      callSite: "subagentSpawn",
    });

    const changedEvents = events.filter(
      (e) => e.type === "system_prompt_changed",
    );
    expect(changedEvents).toHaveLength(1);
    expect(changedEvents[0].systemPrompt).toBe("MUTATED-BY-HOOK");
  });

  test("does not fire when hook returns the same prompt", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "mock-model" },
    });

    hookResponse = {
      conversationId: "test-conv",
      callSite: "mainAgent",
      systemPrompt: "SAME-PROMPT",
      modelProfile: null,
      deferAssistantOutput: false,
      logger: {},
    };

    const { provider } = makeRecordingProvider();
    const events: AgentEvent[] = [];

    const loop = new AgentLoop({
      provider,
      systemPrompt: "SAME-PROMPT",
      config: {},
      conversationId: "test-conv",
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust,
      callSite: "mainAgent",
    });

    const changedEvents = events.filter(
      (e) => e.type === "system_prompt_changed",
    );
    expect(changedEvents).toHaveLength(0);
  });

  test("fires when the hook mutates ctx.systemPrompt in place", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "mock-model" },
    });

    // In-place mode: the mock mutates ctx.systemPrompt directly and
    // returns the same object reference. The old comparison against
    // preModelCtx.systemPrompt would miss this because preModelCtx IS
    // the mutated object. Comparing against providerOptions.systemPrompt
    // (captured pre-hook) catches it.
    hookMutatesInPlace = true;
    hookResponse = {
      conversationId: "test-conv",
      callSite: "mainAgent",
      systemPrompt: "BASELINE\n\n<!-- advisor:steering -->",
      modelProfile: null,
      deferAssistantOutput: false,
      logger: {},
    };

    const { provider } = makeRecordingProvider();
    const events: AgentEvent[] = [];

    const loop = new AgentLoop({
      provider,
      systemPrompt: "BASELINE",
      config: {},
      conversationId: "test-conv",
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust,
      callSite: "mainAgent",
    });

    const changedEvents = events.filter(
      (e) => e.type === "system_prompt_changed",
    );
    expect(changedEvents).toHaveLength(1);
    expect(changedEvents[0].systemPrompt).toBe(
      "BASELINE\n\n<!-- advisor:steering -->",
    );
  });
});
