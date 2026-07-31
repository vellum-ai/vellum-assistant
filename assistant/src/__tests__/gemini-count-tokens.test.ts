/**
 * Coverage for GeminiProvider.countInputTokens — the real Gemini tokenizer via
 * `models.countTokens`. Mirrors generateContent's composition (contents +
 * systemInstruction + tool function declarations); throws when the endpoint
 * returns no `totalTokens` so the daemon falls back to the local estimate.
 */
import { describe, expect, mock, test } from "bun:test";

let lastCountParams: Record<string, unknown> | undefined;
let countResult: { totalTokens?: number } = { totalTokens: 1234 };

mock.module("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {}
    models = {
      countTokens: async (params: Record<string, unknown>) => {
        lastCountParams = params;
        return countResult;
      },
    };
  },
  ApiError: class extends Error {},
  ThinkingLevel: {
    MINIMAL: "MINIMAL",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
  },
}));

import { GeminiProvider } from "../providers/gemini/client.js";
import type { Message, ToolDefinition } from "../providers/types.js";

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];
const tools: ToolDefinition[] = [
  { name: "lookup", description: "d", input_schema: { type: "object" } },
];

describe("GeminiProvider.countInputTokens", () => {
  test("returns totalTokens and forwards model + system + tools", async () => {
    countResult = { totalTokens: 1234 };
    const provider = new GeminiProvider("key", "gemini-3-flash-preview");

    const count = await provider.countInputTokens(
      messages,
      "sys prompt",
      tools,
    );

    expect(count).toBe(1234);
    expect(lastCountParams?.model).toBe("gemini-3-flash-preview");
    const config = lastCountParams?.config as Record<string, unknown>;
    expect(config.systemInstruction).toBe("sys prompt");
    const cfgTools = config.tools as Array<{
      functionDeclarations: Array<{ name: string }>;
    }>;
    expect(cfgTools[0].functionDeclarations[0].name).toBe("lookup");
    expect(Array.isArray(lastCountParams?.contents)).toBe(true);
  });

  test("throws when the endpoint returns no totalTokens (caller falls back)", async () => {
    countResult = {};
    const provider = new GeminiProvider("key", "gemini-3-flash-preview");
    await expect(
      provider.countInputTokens(messages, "sys", undefined),
    ).rejects.toThrow();
  });
});
