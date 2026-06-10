/**
 * Verifies that the `memory-v3-live` cache-anchor signal surfaces on every
 * `SendMessageOptions.config` the loop emits. When the flag is on, the latest
 * user message carries a volatile `<memory>` block, so the loop sets
 * `providerConfig.mutableLatestUserMessage` to tell the provider to anchor its
 * long-TTL cache breakpoint on the most recent STABLE message instead.
 *
 * The loop reads the flag directly where it assembles `providerConfig`, so the
 * signal is sourced from the flag rather than a run option. When the flag is
 * off the field is omitted (not `false`/`undefined`) so the wire stays
 * byte-identical to today.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { AgentLoop } from "../agent/loop.js";
import {
  clearCachedOverrides,
  setCachedOverrides,
} from "../config/feature-flag-cache.js";
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

describe("AgentLoop.run — mutableLatestUserMessage from memory-v3-live", () => {
  afterEach(() => {
    clearCachedOverrides();
  });

  test("sets mutableLatestUserMessage on every LLM call when memory-v3-live is on (multi-turn)", async () => {
    // GIVEN memory-v3-live is enabled
    setCachedOverrides({ "memory-v3-live": true }, { fromGateway: true });

    // AND a provider that records the config of each LLM call across a tool round-trip
    const { provider, configs } = makeRecordingProvider([
      toolUseResponse("t1", "echo", { value: "first" }),
      textResponse("done"),
    ]);
    const dummyTools: ToolDefinition[] = [
      {
        name: "echo",
        description: "Echo back the input",
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ];
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
      tools: dummyTools,
      toolExecutor: async () => ({ content: "ok", isError: false }),
    });

    // WHEN the loop runs
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: () => {},
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
      callSite: "mainAgent",
    });

    // THEN every send (initial + tool round-trip) carries the cache-anchor signal
    expect(configs()).toHaveLength(2);
    for (const cfg of configs()) {
      expect(cfg?.mutableLatestUserMessage).toBe(true);
    }
  });

  test("omits mutableLatestUserMessage when memory-v3-live is off (flag-off byte-identity)", async () => {
    // GIVEN memory-v3-live is off (no override; registry default is false)
    clearCachedOverrides();

    // AND a provider that records the config of each LLM call
    const { provider, configs } = makeRecordingProvider([textResponse("hi")]);
    const loop = new AgentLoop({
      provider: provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
      config: { maxTokens: 1024 },
    });

    // WHEN the loop runs
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
});
