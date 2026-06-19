/**
 * Coverage for the `accurateInputTokens` daemon helper — the provider
 * token-count path used by `/compact` and `/clean`, with a graceful fallback
 * to the local estimate when the provider has no count endpoint or the count
 * request fails.
 */
import { describe, expect, mock, test } from "bun:test";

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

import { accurateInputTokens } from "../daemon/accurate-input-tokens.js";
import type { Message, Provider, ToolDefinition } from "../providers/types.js";

const ESTIMATE = 111;
const estimate = () => ESTIMATE;

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];
const tools: ToolDefinition[] = [
  { name: "t", description: "d", input_schema: { type: "object" } },
];

function baseProvider(): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [],
      model: "mock-model",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
  };
}

describe("accurateInputTokens", () => {
  test("returns the provider count and forwards system prompt + tools", async () => {
    const seen: {
      messages?: Message[];
      systemPrompt?: string;
      tools?: ToolDefinition[];
    } = {};
    const provider: Provider = {
      ...baseProvider(),
      countInputTokens: async (m, systemPrompt, t) => {
        seen.messages = m;
        seen.systemPrompt = systemPrompt;
        seen.tools = t;
        return 9999;
      },
    };

    const count = await accurateInputTokens(
      provider,
      messages,
      "you are a test assistant",
      tools,
      estimate,
    );

    expect(count).toBe(9999);
    expect(seen.messages).toBe(messages);
    expect(seen.systemPrompt).toBe("you are a test assistant");
    expect(seen.tools).toEqual(tools);
  });

  test("falls back to the estimate when the provider has no count endpoint", async () => {
    const count = await accurateInputTokens(
      baseProvider(),
      messages,
      "sys",
      undefined,
      estimate,
    );
    expect(count).toBe(ESTIMATE);
  });

  test("falls back to the estimate when the count request throws", async () => {
    const provider: Provider = {
      ...baseProvider(),
      countInputTokens: async () => {
        throw new Error("rate limited");
      },
    };
    const count = await accurateInputTokens(
      provider,
      messages,
      "sys",
      undefined,
      estimate,
    );
    expect(count).toBe(ESTIMATE);
  });
});
