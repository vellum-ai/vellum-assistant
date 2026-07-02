/**
 * Tests for `AgentLoop.setSystemPrompt` — the seam that lets a conversation
 * update the loop's system prompt between turns.
 *
 * The loop snapshots `this.systemPrompt` once per `run()`, so a conversation
 * that resolves its persona context after the loop is constructed (a voice
 * call binds the caller's trust only after `getOrCreateConversation`) must be
 * able to push the re-resolved prompt in before the next turn. These tests
 * drive the REAL loop against a recording provider and assert the prompt the
 * provider receives, with a pass-through `pre-model-call` hook so the loop's
 * own prompt — not a hook mutation — is what reaches the wire.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Standard logger stub (same shape as the rest of the suite).
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Pass-through plugin pipeline: the `pre-model-call` hook returns its context
// unchanged, so `providerOptions.systemPrompt` stays exactly the prompt the
// loop snapshotted for the run.
mock.module("../plugins/pipeline.js", () => ({
  runHook: async (_hook: unknown, ctx: unknown): Promise<unknown> => ctx,
}));

let mockLlmConfig: Record<string, unknown> = {};
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: mockLlmConfig }),
}));

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

/**
 * Provider that records the system prompt of every send and ends the turn
 * after one call.
 */
function makeRecordingProvider(): {
  provider: Provider;
  capturedSystemPrompts: () => (string | undefined)[];
} {
  const captured: (string | undefined)[] = [];
  const provider: Provider = {
    name: "anthropic",
    async sendMessage(
      _messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      captured.push(options?.systemPrompt);
      return {
        content: [{ type: "text", text: "done" }],
        model: "mock-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  return { provider, capturedSystemPrompts: () => captured };
}

function makeLoop(provider: Provider, systemPrompt: string): AgentLoop {
  return new AgentLoop({
    provider,
    systemPrompt,
    config: {},
    conversationId: "test-conv",
  });
}

async function runOnce(loop: AgentLoop): Promise<void> {
  await loop.run({
    requestId: "test-request",
    messages: [userMessage],
    onEvent: () => {},
    trust,
    callSite: "mainAgent",
  });
}

beforeEach(() => {
  mockLlmConfig = LLMSchema.parse({
    default: { provider: "anthropic", model: "mock-model" },
  }) as Record<string, unknown>;
});

describe("AgentLoop.setSystemPrompt", () => {
  test("a prompt set before the run is what the provider receives", async () => {
    const { provider, capturedSystemPrompts } = makeRecordingProvider();
    const loop = makeLoop(provider, "CONSTRUCTION-PERSONA");

    loop.setSystemPrompt("LATE-BOUND-PERSONA");
    await runOnce(loop);

    expect(capturedSystemPrompts()).toEqual(["LATE-BOUND-PERSONA"]);
  });

  test("without a push, the construction-time prompt is used", async () => {
    const { provider, capturedSystemPrompts } = makeRecordingProvider();
    const loop = makeLoop(provider, "CONSTRUCTION-PERSONA");

    await runOnce(loop);

    expect(capturedSystemPrompts()).toEqual(["CONSTRUCTION-PERSONA"]);
  });

  test("a prompt pushed between turns takes effect on the next run", async () => {
    const { provider, capturedSystemPrompts } = makeRecordingProvider();
    const loop = makeLoop(provider, "FIRST-PERSONA");

    await runOnce(loop);
    loop.setSystemPrompt("SECOND-PERSONA");
    await runOnce(loop);

    expect(capturedSystemPrompts()).toEqual([
      "FIRST-PERSONA",
      "SECOND-PERSONA",
    ]);
  });
});
