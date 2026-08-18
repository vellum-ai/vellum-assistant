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
import { buildUsageOriginSnapshot } from "../usage/work-origin.js";

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

  // A schedule firing inside a conversation whose type and source stay
  // standard/user is invisible to a row-derived classification, so the turn's
  // snapshot is what keeps a scheduled analysis out of interactive spend.
  test("carries the turn's origin when the analysis runs inside a scheduled turn", async () => {
    const snapshot = buildUsageOriginSnapshot({
      conversationType: "standard",
      conversationSource: "user",
      callSite: "mainAgent",
      conversationId: "conv-xyz",
      turnIndex: 4,
      parentConversationId: null,
      parentTurnIndex: null,
      cronRunId: "cron-run-1",
    });

    await extractStylePatterns([sentMessage("Hi Bob, sounds good.")], {
      conversationId: "conv-xyz",
      usageOriginSnapshot: snapshot,
    });

    expect(lastSendOptions?.config?.usageOriginSnapshot).toBe(snapshot);
    expect(lastSendOptions?.config?.usageOriginSnapshot?.workOrigin).toBe(
      "user_created_schedule",
    );
    // The conversation id still rides alongside for callers running outside a
    // turn, whose sends have no snapshot to classify from.
    expect(lastSendOptions?.config?.conversationId).toBe("conv-xyz");
  });

  test("omits the snapshot key when the caller has no turn origin", async () => {
    await extractStylePatterns([sentMessage("Hi Bob, sounds good.")], {
      conversationId: "conv-xyz",
    });

    expect(lastSendOptions?.config?.usageOriginSnapshot).toBeUndefined();
  });
});
