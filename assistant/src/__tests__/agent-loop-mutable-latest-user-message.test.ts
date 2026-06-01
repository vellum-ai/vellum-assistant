/**
 * Verifies that the per-turn `mutableLatestUserMessage` plumbed into
 * `AgentLoop.run()` surfaces on every `SendMessageOptions.config` the loop
 * emits — this is the memory-v3-live cache-anchor signal (the latest user
 * message carries a volatile `<memory>` block, so the provider must anchor its
 * long-TTL cache breakpoint on the most recent STABLE message instead).
 *
 * Default behavior (option unset) must remain unchanged — the field is omitted
 * from `providerConfig` rather than carrying `undefined`/`false`, so the wire
 * is byte-identical to today when the flag is off.
 */

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { AgentLoop } from "../agent/loop.js";
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

describe("AgentLoop.run — mutableLatestUserMessage plumbing", () => {
  test("forwards mutableLatestUserMessage=true to providerConfig on every LLM call (multi-turn)", async () => {
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

    const toolExecutor = async () => ({ content: "ok", isError: false });

    const loop = new AgentLoop(provider, "system", {
      config: { maxTokens: 1024 },
      tools: dummyTools,
      toolExecutor: toolExecutor,
    });

    await loop.run([userMessage], () => {}, {
      callSite: "mainAgent",
      mutableLatestUserMessage: true,
    });

    // Two sends — initial + one tool round-trip. Every send carries the flag.
    expect(configs()).toHaveLength(2);
    for (const cfg of configs()) {
      expect(cfg?.mutableLatestUserMessage).toBe(true);
    }
  });

  test("omits mutableLatestUserMessage when unset (default behavior unchanged)", async () => {
    const { provider, configs } = makeRecordingProvider([textResponse("hi")]);
    const loop = new AgentLoop(provider, "system", {
      config: { maxTokens: 1024 },
    });

    await loop.run([userMessage], () => {});

    expect(configs()).toHaveLength(1);
    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
  });

  test("omits mutableLatestUserMessage when explicitly false (flag-off byte-identity)", async () => {
    const { provider, configs } = makeRecordingProvider([textResponse("hi")]);
    const loop = new AgentLoop(provider, "system", {
      config: { maxTokens: 1024 },
    });

    await loop.run([userMessage], () => {}, {
      callSite: "mainAgent",
      mutableLatestUserMessage: false,
    });

    expect("mutableLatestUserMessage" in (configs()[0] ?? {})).toBe(false);
  });
});
