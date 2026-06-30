/**
 * The compaction summarizer's input.
 *
 * Both the budget gate and overflow recovery summarize the *injected* history
 * (the genuine conversation as the agent saw it) so the summary call's prompt
 * prefix matches the agent's warm prefix cache — a cache read rather than a
 * fresh cache write. The agent loop hands the full injected history to
 * compaction unconditionally; the post-compaction re-injection hook owns
 * injection idempotency by stripping the tail's per-turn blocks before
 * re-applying them.
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

const CONVERSATION_ID = "compaction-strip-conversation";

/**
 * A runtime `<workspace>` injection block. Its presence in the summarizer's
 * input proves compaction received the injected history rather than a stripped
 * copy.
 */
const WORKSPACE_INJECTION =
  "<workspace>\nActive workspace: project-x\n</workspace>";
const TURN_BODY = "Hello there, this is the turn body.";

/**
 * A user turn carrying a real text block plus a runtime injection block, both
 * of which ride into compaction's input as-is.
 */
const injectedUserMessage: Message = {
  role: "user",
  content: [
    { type: "text", text: TURN_BODY },
    { type: "text", text: WORKSPACE_INJECTION },
  ],
};

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

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

interface CompactionInputCapture {
  budget: Message[] | null;
  overflow: Message[] | null;
}

/**
 * Install a per-conversation manager that records the messages handed to the
 * budget summarizer (`maybeCompact`) and to overflow recovery
 * (`recoverContextOverflow`).
 */
function installCapturingManager(capture: CompactionInputCapture): {
  trust: TrustContext;
} {
  createContextWindowManager({
    provider: { name: "mock-provider" } as unknown as Provider,
    config: {} as unknown as ContextWindowConfig,
    conversationId: CONVERSATION_ID,
  });
  const manager = getContextWindowManager(CONVERSATION_ID);
  if (manager) {
    manager.maybeCompact = (async (messages: Message[]) => {
      capture.budget = messages;
      return {
        messages: [injectedUserMessage],
        compacted: true,
        exhausted: false,
      };
    }) as unknown as typeof manager.maybeCompact;
    manager.recoverContextOverflow = (async (messages: Message[]) => {
      capture.overflow = messages;
      return {
        messages: [injectedUserMessage],
        compacted: true,
        exhausted: false,
      };
    }) as unknown as typeof manager.recoverContextOverflow;
  }
  return { trust: { sourceChannel: "vellum", trustClass: "unknown" } };
}

function serialize(messages: Message[] | null): string {
  return JSON.stringify(messages ?? []);
}

describe("AgentLoop compaction summarizer input", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(testPostCompactPlugin);
  });

  afterEach(() => {
    disposeContextWindowManager(CONVERSATION_ID);
  });

  test("budget-gate compaction summarizes the injected history", async () => {
    // GIVEN a history whose user turn carries a runtime-injection block
    const capture: CompactionInputCapture = { budget: null, overflow: null };
    const provider = createMockProvider([
      textResponse("done after compaction"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: CONVERSATION_ID,
      tools: [],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });
    const events: AgentEvent[] = [];

    // WHEN the budget gate trips and in-place compaction runs
    await loop.run({
      requestId: "req",
      messages: [injectedUserMessage],
      onEvent: (event) => {
        events.push(event);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: true,
      ...installCapturingManager(capture),
    });

    // THEN the budget summarizer received the injected history, injection intact
    expect(capture.budget).not.toBeNull();
    expect(serialize(capture.budget)).toContain("<workspace>");
    // AND overflow recovery was not invoked
    expect(capture.overflow).toBeNull();
    // AND the history-stripped marker still fires for the durable base
    expect(events.some((e) => e.type === "history_stripped")).toBe(true);
  });

  test("overflow-driven compaction summarizes the injected history", async () => {
    // GIVEN a history whose user turn carries a runtime-injection block
    const capture: CompactionInputCapture = { budget: null, overflow: null };

    // AND a provider that rejects the first call as context-too-large
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
    // A blocking watermark plus `compactInPlace: false` keep the budget gate
    // from firing, so only the overflow rejection drives compaction.
    loop.compactionCircuit.lastPostCompactionEstimate = 0;
    const events: AgentEvent[] = [];

    // WHEN the provider overflow forces overflow recovery
    await loop.run({
      requestId: "req",
      messages: [injectedUserMessage],
      onEvent: (event) => {
        events.push(event);
      },
      modelProfileKey: "balanced",
      resolveContextWindow: () => ({
        maxInputTokens: 10,
        overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
      }),
      compactInPlace: false,
      ...installCapturingManager(capture),
    });

    // THEN overflow recovery received the injected history, injection intact
    expect(capture.overflow).not.toBeNull();
    expect(serialize(capture.overflow)).toContain("<workspace>");
    // AND the real turn body is present alongside the injection
    expect(serialize(capture.overflow)).toContain(TURN_BODY);
    // AND the budget summarizer was not invoked
    expect(capture.budget).toBeNull();
  });
});
