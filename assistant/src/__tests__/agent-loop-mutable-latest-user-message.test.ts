/**
 * Verifies the agent loop's cache-anchor signal for the memory-v3 pointer: a
 * `<memory_pointer>` block on the turn-starting user message flags that
 * message as volatile (`mutableLatestUserMessage`) for every request in the
 * turn, the loop sends the block as-is (assembly, not the loop, strips it on
 * the next turn), and a history with no pointer sets no flag at all so the
 * wire config stays byte-identical.
 */

import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../agent/loop.js";
import { wrapMemoryPointerBlock } from "../plugins/defaults/memory/memory-marker.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

const pointerText = wrapMemoryPointerBlock(
  "Already in context above, relevant again this turn:\nmemory/concepts/plans.md § Alpha",
);

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

const userMessageWithPointer: Message = {
  role: "user",
  content: [
    { type: "text", text: "hi" },
    { type: "text", text: pointerText },
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
  sent: () => Message[][];
} {
  const configs: Array<Record<string, unknown> | undefined> = [];
  const sent: Message[][] = [];
  let i = 0;
  const provider: Provider = {
    name: "mock",
    async sendMessage(
      messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      sent.push(messages);
      configs.push(options?.config as Record<string, unknown> | undefined);
      const response = responses[i] ?? responses[responses.length - 1];
      i++;
      return response;
    },
  };
  return { provider, configs: () => configs, sent: () => sent };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echo back the input",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
  },
};

describe("AgentLoop.run: memory-v3 pointer on the turn-start message", () => {
  test("sends the pointer as-is and flags the turn start as volatile", async () => {
    const { provider, configs, sent } = makeRecordingProvider([
      textResponse("done"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
    });

    const result = await loop.run({
      requestId: "test-request",
      messages: [userMessageWithPointer],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    expect(sent()).toHaveLength(1);
    expect(sent()[0]![0]!.content).toEqual(userMessageWithPointer.content);
    expect(result.history[0]!.content).toEqual(userMessageWithPointer.content);
    expect(configs()[0]?.mutableLatestUserMessage).toBe(true);
  });

  test("does not set mutableLatestUserMessage when history has no pointer", async () => {
    const { provider, sent, configs } = makeRecordingProvider([
      textResponse("hi"),
    ]);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
    });

    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    expect(sent()[0]).toEqual([userMessage]);
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
  });

  test("holds the flag steady through a tool loop and keeps the pointer on the opening message", async () => {
    const { provider, sent, configs } = makeRecordingProvider([
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

    const result = await loop.run({
      requestId: "test-request",
      messages: [userMessageWithPointer],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    expect(sent()).toHaveLength(2);
    expect(sent()[0]![0]!.content).toEqual(userMessageWithPointer.content);
    expect(sent()[1]![0]!.content).toEqual(userMessageWithPointer.content);
    expect(result.history[0]!.content).toEqual(userMessageWithPointer.content);
    // The trailing tool-result message is user-role but carries no text, so
    // the signal still reads the opening message on the second request.
    expect(configs()[0]?.mutableLatestUserMessage).toBe(true);
    expect(configs()[1]?.mutableLatestUserMessage).toBe(true);
  });
});
