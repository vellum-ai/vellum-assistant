/**
 * Verifies that a persisted memory-v3 pointer already in history is sent
 * as-is and does not flag the turn-start message as volatile.
 *
 * The pointer stays on the user message that was sent. The loop must not
 * attach, strip, or mark that message mutable.
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

describe("AgentLoop.run: persisted pointer in history", () => {
  test("sends a pointer already in history and does not flag the turn-start as volatile", async () => {
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
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
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

  test("keeps a persisted pointer on the opening user message through a tool loop", async () => {
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
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
    expect("mutableLatestUserMessage" in (configs()[1] ?? {})).toBe(false);
  });
});
