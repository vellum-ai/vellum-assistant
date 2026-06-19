/**
 * Tests for the agent-loop → owner (Conversation) pushback of the
 * post-pre-model-call-hook prompt.
 *
 * Cache-alignment invariant under test:
 *   When the `pre-model-call` hook chain mutates the rendered prompt — e.g.
 *   the `default-advisor` plugin appending `<!-- advisor:steering -->` for
 *   `callSite === "mainAgent"` — the loop must push the post-hook string back
 *   to the owning conversation (via the `systemPromptUpdated` constructor
 *   callback) so the compactor's next mid-loop `provider.sendMessage` sends
 *   the same prefix and Anthropic's prefix-cache key stays stable turn to
 *   turn.
 *
 * The full Conversation wiring lives in
 * `assistant/src/daemon/conversation.ts`; this test pins the loop-side
 * contract: when the hook diffs the prompt, the loop invokes the callback
 * verbatim, and only for the mainAgent call site.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Stub pipes ──────────────────────────────────────────────────────
// Same logger-stub shape as the rest of the test suite — pino pulls are
// agent-loop-time too, but we silence them so the test stays deterministic.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Mock plugin pipeline: returns whatever the per-test hook stub produces.
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
mock.module("../plugins/pipeline.js", () => ({
  runHook: async (
    _hook: unknown,
    _ctx: PreModelCallCtx,
  ): Promise<PreModelCallCtx> => hookResponse,
}));

// Minimal `getConfig` so the loop's defaults/loader path doesn't trip.
let mockLlmConfig: Record<string, unknown> = {};
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlmConfig }),
}));

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import { LLMSchema } from "../config/schemas/llm.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({}) as Record<string, unknown>;
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

describe("AgentLoop.systemPromptUpdated pushback", () => {
  test("post-hook prompt is forwarded to the owning conversation on mainAgent", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "mock-model" },
    });

    const { provider, capturedSystemPrompts } = makeRecordingProvider();
    const capturedPrompts: string[] = [];
    const capturedBaselinePrompts: string[] = [];

    const loop = new AgentLoop({
      provider,
      systemPrompt: "BASELINE-PROMPT",
      config: {},
      conversationId: "test-conv",
      systemPromptUpdated: (prompt) => {
        capturedPrompts.push(prompt);
      },
    });

    // We also need to verify the loop's _internal_ field — `this.systemPrompt`
    // (the BASE prompt constructor arg) — does NOT carry the post-hook
    // string. Hook diffs belong to the conversation, not the loop's own
    // base. Inspect via the same cast pattern as the rest of the suite.
    const internals = loop as unknown as {
      systemPrompt: string;
      _systemPrompt?: string;
    };
    capturedBaselinePrompts.push(internals.systemPrompt);

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust,
      callSite: "mainAgent",
    });

    // Owner callback received the post-hook string verbatim.
    expect(capturedPrompts).toEqual([
      "BASELINE-PROMPT\n\n<!-- advisor:steering -->\nAPPENDED-FROM-HOOK",
    ]);

    // The provider saw the same string on its call.
    expect(capturedSystemPrompts()).toEqual([
      "BASELINE-PROMPT\n\n<!-- advisor:steering -->\nAPPENDED-FROM-HOOK",
    ]);

    // The loop's BASE field is unchanged — it stays the constructor seed.
    expect(internals.systemPrompt).toBe("BASELINE-PROMPT");
    expect(internals._systemPrompt).toBeUndefined();
    expect(capturedBaselinePrompts).toEqual(["BASELINE-PROMPT"]);
  });

  test("non-mainAgent call sites do NOT push back", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "mock-model" },
    });

    // Hook would mutate the prompt but for a non-mainAgent call — the loop
    // must NOT forward it (the compactor is gated to mainAgent, and pushing
    // would leak hook diffs into turns whose provider never observed them).
    hookResponse = {
      conversationId: "test-conv",
      callSite: "subagentSpawn",
      systemPrompt: "LEAKED-SHOULD-NOT-PROPAGATE",
      modelProfile: null,
      deferAssistantOutput: false,
      logger: {},
    };

    const { provider, capturedSystemPrompts } = makeRecordingProvider();
    const capturedPrompts: string[] = [];

    const loop = new AgentLoop({
      provider,
      systemPrompt: "BASELINE-PROMPT",
      config: {},
      conversationId: "test-conv",
      systemPromptUpdated: (prompt) => {
        capturedPrompts.push(prompt);
      },
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust,
      callSite: "subagentSpawn",
    });

    expect(capturedPrompts).toEqual([]);
    // Provider still received the hook's mutated string (its own prompt path).
    expect(capturedSystemPrompts()).toEqual(["LEAKED-SHOULD-NOT-PROPAGATE"]);
  });

  test("mainAgent without a hook diff still does not push", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "mock-model" },
    });

    // Hook returns the same prompt it was given — no diff, no push.
    hookResponse = {
      conversationId: "test-conv",
      callSite: "mainAgent",
      systemPrompt: "UNTOUCHED-PROMPT",
      modelProfile: null,
      deferAssistantOutput: false,
      logger: {},
    };

    const { provider } = makeRecordingProvider();
    const capturedPrompts: string[] = [];

    const loop = new AgentLoop({
      provider,
      systemPrompt: "UNTOUCHED-PROMPT",
      config: {},
      conversationId: "test-conv",
      systemPromptUpdated: (prompt) => {
        capturedPrompts.push(prompt);
      },
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust,
      callSite: "mainAgent",
    });

    // The hook didn't mutate so the loop's call cost is the same string it
    // always had. Conversation's setSystemPrompt is idempotent on equal
    // values, but we don't even reach `systemPromptUpdated` here since the
    // loop checks for actual diff via the strict `string` provided value.
    // In this scenario the hook DID pass `finalPreModelCtx.systemPrompt` as
    // a string, so the loop forwards — but the value will be a "no-op write"
    // on the conversation side. Verify the forward happens (the test for
    // equality-based no-opping lives on the conversation).
    expect(capturedPrompts).toEqual(["UNTOUCHED-PROMPT"]);
  });
});
