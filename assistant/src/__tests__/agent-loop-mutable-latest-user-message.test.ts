/**
 * Verifies that the loop attaches an outbound-only memory-v3 spotlight on
 * the provider request without writing it into stored history, and that it
 * no longer flags the turn-start message as volatile.
 *
 * Spotlight is an uncached suffix after the user's text. The provider places
 * the long-TTL breakpoint on the last stable block, so historical user
 * messages stay byte-identical across turns.
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

const spotlightText = wrapMemorySpotlightBlock("recalled: Alice's plan");

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

describe("AgentLoop.run: outbound spotlight attach", () => {
  test("attaches spotlight on the outbound request and leaves stored history clean", async () => {
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
      messages: [userMessage],
      outboundSpotlight: spotlightText,
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    expect(sent()).toHaveLength(1);
    expect(sent()[0]![0]!.content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: spotlightText },
    ]);
    expect(result.history[0]!.content).toEqual([{ type: "text", text: "hi" }]);
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
  });

  test("omits spotlight on the wire when outboundSpotlight is absent", async () => {
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

  test("reattaches the same spotlight on every request in a tool loop", async () => {
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
      messages: [userMessage],
      outboundSpotlight: spotlightText,
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    expect(sent()).toHaveLength(2);
    expect(sent()[0]![0]!.content.at(-1)).toEqual({
      type: "text",
      text: spotlightText,
    });
    expect(sent()[1]![0]!.content.at(-1)).toEqual({
      type: "text",
      text: spotlightText,
    });
    expect(result.history[0]!.content).toEqual([{ type: "text", text: "hi" }]);
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
    expect("mutableLatestUserMessage" in (configs()[1] ?? {})).toBe(false);
  });
});
