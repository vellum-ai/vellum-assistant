/**
 * Characterization: the provider send boundary is a field-by-field
 * reconstruction whitelist, so persisted-block metadata that future mention
 * work might attach (rider fields on text blocks, custom block types) can
 * never leak to the provider wire. Pins the guarantees LUM-3023's projection
 * design relies on:
 *  - extra fields on a known block type are dropped (text rebuilt as
 *    `{type, text}` only),
 *  - unknown block types are dropped entirely rather than serialized,
 *  - the failure mode is silent omission, never a provider-rejected payload.
 *
 * These tests pin current behavior; nothing here changes it.
 */

import { describe, expect, mock, test } from "bun:test";

import type { ContentBlock, Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock Anthropic SDK; must be registered before importing the provider.
// Mirrors the harness shape in native-web-search.test.ts.
// ---------------------------------------------------------------------------

let lastStreamParams: Record<string, unknown> | null = null;

const fakeResponse = {
  content: [{ type: "text", text: "ok" }],
  model: "claude-sonnet-4-6",
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  stop_reason: "end_turn",
};

class FakeAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "APIError";
  }
}

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    static APIError = FakeAPIError;
    constructor(_args: Record<string, unknown>) {}
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          lastStreamParams = JSON.parse(JSON.stringify(params));
          return {
            on() {
              return this;
            },
            async finalMessage() {
              return fakeResponse;
            },
          };
        },
      },
    };
  },
}));

import { AnthropicProvider } from "../providers/anthropic/client.js";

async function sendAndCapture(
  blocks: ContentBlock[],
): Promise<Array<{ role: string; content: Array<Record<string, unknown>> }>> {
  lastStreamParams = null;
  const provider = new AnthropicProvider("test-key", "claude-sonnet-4-6");
  const messages: Message[] = [{ role: "user", content: blocks }];
  await provider.sendMessage(messages);
  return lastStreamParams!.messages as Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
}

describe("provider serializer leak audit", () => {
  test("rider fields on a text block never reach the wire", async () => {
    const sent = await sendAndCapture([
      {
        type: "text",
        text: "transcribed words",
        _ingressAugmentation: "transcription",
      } as unknown as ContentBlock,
      { type: "text", text: "caption body" },
    ]);

    const userMsg = sent.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    for (const block of userMsg!.content) {
      expect(block).not.toHaveProperty("_ingressAugmentation");
    }
    // The rider-bearing block still ships as plain text: silent field drop,
    // not block loss.
    const texts = userMsg!.content
      .filter((b) => b.type === "text")
      .map((b) => b.text);
    expect(texts).toContain("transcribed words");
    expect(texts).toContain("caption body");
    expect(JSON.stringify(lastStreamParams)).not.toContain(
      "_ingressAugmentation",
    );
  });

  test("unknown block types are dropped, not serialized", async () => {
    const sent = await sendAndCapture([
      {
        type: "slack_mention_source",
        rawText: "<#C0123DEST>",
      } as unknown as ContentBlock,
      { type: "text", text: "visible text" },
    ]);

    const userMsg = sent.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(
      userMsg!.content.some((b) => b.type === "slack_mention_source"),
    ).toBe(false);
    expect(JSON.stringify(lastStreamParams)).not.toContain(
      "slack_mention_source",
    );
    expect(
      userMsg!.content.some(
        (b) => b.type === "text" && b.text === "visible text",
      ),
    ).toBe(true);
  });
});
