import { describe, expect, test } from "bun:test";

import type Anthropic from "@anthropic-ai/sdk";

import { AnthropicProvider, MAX_PAUSE_TURN_CONTINUATIONS } from "../client.js";

function makeMessage(overrides: {
  stop_reason: Anthropic.Message["stop_reason"];
  content: Anthropic.ContentBlock[];
  usage?: Partial<Anthropic.Usage>;
}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    stop_sequence: null,
    content: overrides.content,
    stop_reason: overrides.stop_reason,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      ...overrides.usage,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: null } as Anthropic.ContentBlock;
}

function serverToolUseBlock(id: string): Anthropic.ContentBlock {
  return {
    type: "server_tool_use",
    id,
    name: "web_search",
    input: { query: "test" },
  } as Anthropic.ContentBlock;
}

/**
 * Stub the SDK client on a provider instance. Every stream call records its
 * params and resolves to the next response in `responses` (repeating the last
 * one once exhausted). Both the plain and beta endpoints share the recorder —
 * which endpoint fires depends on the model's beta set.
 */
function stubProvider(responses: Anthropic.Message[]): {
  provider: AnthropicProvider;
  calls: Anthropic.MessageStreamParams[];
} {
  const provider = new AnthropicProvider("test-key", "claude-opus-4-6");
  const calls: Anthropic.MessageStreamParams[] = [];
  const stream = (params: Anthropic.MessageStreamParams) => {
    calls.push(params);
    const response =
      responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      on() {
        return this;
      },
      async finalMessage() {
        return response;
      },
    };
  };
  (provider as unknown as { client: unknown }).client = {
    baseURL: "https://api.anthropic.com",
    messages: { stream },
    beta: { messages: { stream } },
  };
  return { provider, calls };
}

describe("pause_turn continuation", () => {
  test("resends the paused assistant content as-is and merges the segments", async () => {
    const pausedContent = [
      textBlock("Searching..."),
      serverToolUseBlock("srvtoolu_1"),
    ];
    const { provider, calls } = stubProvider([
      makeMessage({
        stop_reason: "pause_turn",
        content: pausedContent,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      makeMessage({
        stop_reason: "end_turn",
        content: [textBlock("Done")],
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
        },
      }),
    ]);

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "search something" }] },
    ]);

    expect(calls.length).toBe(2);
    // The continuation appends the paused assistant message unchanged.
    expect(calls[1].messages.length).toBe(calls[0].messages.length + 1);
    const appended = calls[1].messages[calls[1].messages.length - 1];
    expect(appended.role).toBe("assistant");
    expect(appended.content).toBe(pausedContent);

    // Content is the concatenation of the paused segment and the final one.
    expect(result.content).toEqual([
      { type: "text", text: "Searching..." },
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "test" },
      },
      { type: "text", text: "Done" },
    ]);
    expect(result.stopReason).toBe("end_turn");

    // Usage sums across both billed requests (input includes cache tokens).
    expect(result.usage.inputTokens).toBe(10 + 20 + 3 + 4);
    expect(result.usage.outputTokens).toBe(12);
    expect(result.usage.cacheCreationInputTokens).toBe(3);
    expect(result.usage.cacheReadInputTokens).toBe(4);
  });

  test("a turn that never pauses issues a single request", async () => {
    const { provider, calls } = stubProvider([
      makeMessage({
        stop_reason: "end_turn",
        content: [textBlock("Hi")],
        usage: { input_tokens: 8, output_tokens: 2 },
      }),
    ]);

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);

    expect(calls.length).toBe(1);
    expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.inputTokens).toBe(8);
    expect(result.usage.cacheCreationInputTokens).toBeUndefined();
    expect(result.usage.cacheReadInputTokens).toBeUndefined();
  });

  test("stops resending at the continuation cap and returns the paused response", async () => {
    const { provider, calls } = stubProvider([
      makeMessage({
        stop_reason: "pause_turn",
        content: [serverToolUseBlock("srvtoolu_stuck")],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);

    const result = await provider.sendMessage([
      { role: "user", content: [{ type: "text", text: "search forever" }] },
    ]);

    expect(calls.length).toBe(1 + MAX_PAUSE_TURN_CONTINUATIONS);
    expect(result.stopReason).toBe("pause_turn");
    // Every billed request's usage is accounted for.
    expect(result.usage.inputTokens).toBe(1 + MAX_PAUSE_TURN_CONTINUATIONS);
  });
});
