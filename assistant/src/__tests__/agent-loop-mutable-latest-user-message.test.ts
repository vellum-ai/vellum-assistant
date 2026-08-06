/**
 * Verifies how the loop derives the `mutableLatestUserMessage` cache-anchor
 * signal on `SendMessageOptions.config`.
 *
 * The signal means "the latest user message's bytes do not recur next turn", so
 * it is set from the history actually being sent: only when the latest user
 * message carries a memory-v3 `<memory_spotlight>` block, the one injected
 * block that is strip-and-replaced on the tail every turn. Every other injected
 * block is frozen into history and re-renders byte-identically, so turns
 * without a spotlight keep a normal cache anchor even when memory-v3 is live.
 *
 * When no spotlight is present the field is omitted entirely (not `false`) so
 * the wire stays byte-identical for conversations that never see one.
 */

import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../agent/loop.js";
import { wrapMemorySpotlightBlock } from "../plugins/defaults/memory/memory-marker.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

/** A user turn whose tail block is the ephemeral memory-v3 spotlight. */
const spotlightUserMessage: Message = {
  role: "user",
  content: [
    { type: "text", text: "hi" },
    { type: "text", text: wrapMemorySpotlightBlock("recalled: Alice's plan") },
  ],
};

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function toolUseResponse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

function makeRecordingProvider(responses: ProviderResponse[]): {
  provider: Provider;
  configs: () => Array<Record<string, unknown> | undefined>;
} {
  const configs: Array<Record<string, unknown> | undefined> = [];
  let i = 0;
  const provider: Provider = {
    name: "mock",
    async sendMessage(
      _messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      configs.push(options?.config as Record<string, unknown> | undefined);
      const response = responses[i] ?? responses[responses.length - 1];
      i++;
      return response;
    },
  };
  return { provider, configs: () => configs };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echo back the input",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
  },
};

describe("AgentLoop.run: mutableLatestUserMessage from spotlight presence", () => {
  test("sets mutableLatestUserMessage when the latest user message carries a spotlight block", async () => {
    // GIVEN a provider that records the config of each LLM call
    const { provider, configs } = makeRecordingProvider([textResponse("done")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
    });

    // WHEN the loop runs over a history whose tail carries the spotlight
    await loop.run({
      requestId: "test-request",
      messages: [spotlightUserMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // THEN the send carries the cache-anchor signal
    expect(configs()).toHaveLength(1);
    expect(configs()[0]?.mutableLatestUserMessage).toBe(true);
  });

  test("omits mutableLatestUserMessage when the latest user message carries no spotlight", async () => {
    // GIVEN a provider that records the config of each LLM call
    const { provider, configs } = makeRecordingProvider([textResponse("hi")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
    });

    // WHEN the loop runs over a spotlight-free history: the shape memory-v3
    // produces whenever it selects nothing to spotlight
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // THEN the field is omitted entirely, not carried as false/undefined
    expect(configs()).toHaveLength(1);
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
  });

  test("a text block merely opening with the spotlight tag is not treated as volatile", async () => {
    // GIVEN a user message discussing the marker rather than carrying one
    const { provider, configs } = makeRecordingProvider([textResponse("hi")]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
    });

    // WHEN the loop runs
    await loop.run({
      requestId: "test-request",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<memory_spotlight>\nwhat does this tag do?",
            },
          ],
        },
      ],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // THEN the unterminated wrapper does not count: matching the full-wrapper
    // requirement the per-turn strip applies
    expect(configs()).toHaveLength(1);
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
  });

  test("the signal holds for every request in a tool loop", async () => {
    // GIVEN a spotlight-bearing opening message and a tool round-trip
    const { provider, configs } = makeRecordingProvider([
      toolUseResponse("t1", "echo", { value: "first" }),
      textResponse("done"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
      tools: [echoTool],
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });

    // WHEN the loop runs
    await loop.run({
      requestId: "test-request",
      messages: [spotlightUserMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // THEN both calls report the turn as volatile. The signal describes the
    // turn-starting message, not whichever user message happens to be last, so
    // the trailing tool-result turn does not clear it. Holding it steady is
    // what keeps the provider marking that one block at a single TTL for the
    // whole turn instead of writing it twice.
    expect(configs()).toHaveLength(2);
    expect(configs()[0]?.mutableLatestUserMessage).toBe(true);
    expect(configs()[1]?.mutableLatestUserMessage).toBe(true);
  });
});
