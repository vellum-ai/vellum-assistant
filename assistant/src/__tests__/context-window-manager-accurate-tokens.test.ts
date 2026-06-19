/**
 * Coverage for `ContextWindowManager.accurateInputTokens` — the provider
 * token-count path used by `/compact` and `/clean` to render the real
 * tokenizer count, with a graceful fallback to the local estimator when the
 * provider has no count endpoint or the count request fails.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

// Sentinel the local estimator returns so tests can tell a fallback apart
// from a real provider count.
const ESTIMATE_SENTINEL = 111;
mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: (): number => ESTIMATE_SENTINEL,
  estimateToolsTokens: (): number => 0,
  getCalibrationProviderKey: (p: { name: string }): string => p.name,
}));

import { ContextWindowManager } from "../plugins/defaults/compaction/window-manager.js";
import type { Message, Provider, ToolDefinition } from "../providers/types.js";

function makeConfig() {
  return {
    enabled: true,
    maxInputTokens: 200_000,
    targetBudgetRatio: 0.3,
    compactThreshold: 0.8,
    summaryBudgetRatio: 0.05,
    overflowRecovery: {
      enabled: true,
      safetyMarginRatio: 0.05,
      maxAttempts: 3,
      interactiveLatestTurnCompression: "summarize" as const,
      nonInteractiveLatestTurnCompression: "summarize" as const,
    },
  };
}

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

describe("ContextWindowManager.accurateInputTokens", () => {
  beforeEach(() => {});

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
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "you are a test assistant",
      config: makeConfig(),
      resolveTools: () => tools,
    });

    const count = await manager.accurateInputTokens(messages);

    expect(count).toBe(9999);
    expect(seen.messages).toBe(messages);
    expect(seen.systemPrompt).toBe("you are a test assistant");
    expect(seen.tools).toEqual(tools);
  });

  test("falls back to the local estimate when the provider has no count endpoint", async () => {
    const manager = new ContextWindowManager({
      provider: baseProvider(),
      systemPrompt: "sys",
      config: makeConfig(),
    });

    expect(await manager.accurateInputTokens(messages)).toBe(ESTIMATE_SENTINEL);
  });

  test("falls back to the local estimate when the count request throws", async () => {
    const provider: Provider = {
      ...baseProvider(),
      countInputTokens: async () => {
        throw new Error("rate limited");
      },
    };
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "sys",
      config: makeConfig(),
    });

    expect(await manager.accurateInputTokens(messages)).toBe(ESTIMATE_SENTINEL);
  });
});
