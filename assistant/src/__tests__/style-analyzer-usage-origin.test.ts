/**
 * Pins that the style analyzer's LLM call carries the assistant conversation
 * it runs under. `normalizeSendMessageOptions` derives billing-origin headers
 * from `config.conversationId` when no explicit snapshot is stamped, so a send
 * without it loses all conversation provenance.
 */
import { describe, expect, mock, test } from "bun:test";

import type { SendMessageOptions } from "../providers/types.js";

/** Options the stubbed provider's most recent sendMessage call received. */
let lastSendOptions: SendMessageOptions | undefined;

const analysisResponse = {
  content: [
    {
      type: "tool_use",
      id: "toolu_style",
      name: "store_style_analysis",
      input: {
        style_patterns: [
          { aspect: "tone", summary: "Warm and direct.", importance: 0.7 },
        ],
      },
    },
  ],
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: "tool_use",
};

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => ({
    name: "test-provider",
    // `any` keeps the stub assignable to Provider without restating its shape.
    sendMessage: async (_messages: any, options: any) => {
      lastSendOptions = options;
      return analysisResponse;
    },
  }),
}));

import type { Message as ProviderMessage } from "../messaging/provider-types.js";
import { extractStylePatterns } from "../messaging/style-analyzer.js";

function sentMessage(text: string): ProviderMessage {
  return {
    id: "msg-1",
    conversationId: "thread-1",
    sender: { id: "user-123", name: "Alice" },
    text,
    timestamp: 0,
    platform: "gmail",
  };
}

describe("extractStylePatterns billing origin", () => {
  test("forwards the assistant conversation id on the send config", async () => {
    await extractStylePatterns([sentMessage("Hi Bob, sounds good.")], {
      conversationId: "conv-xyz",
    });

    expect(lastSendOptions?.config?.callSite).toBe("styleAnalyzer");
    expect(lastSendOptions?.config?.conversationId).toBe("conv-xyz");
  });
});
