import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockRunBtwSidechain = mock(async () => ({
  text: "Project kickoff",
  hadTextDeltas: true,
  response: {
    content: [{ type: "text", text: "Project kickoff" }],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  },
}));

const mockGetConversation = mock(
  (_conversationId: string) =>
    ({
      title: "Generating title...",
      isAutoTitle: 1,
    }) as {
      title: string;
      isAutoTitle: number;
    },
);
const mockGetMessages = mock(() => [
  { role: "user", content: "first message" },
  { role: "assistant", content: "first reply" },
  { role: "user", content: "follow-up" },
]);
const mockUpdateConversationTitle = mock(() => {});
const mockGetConfiguredProvider = mock(async () => null);
const mockGetConfig = mock(() => ({
  daemon: {
    titleGenerationMaxTokens: 37,
  },
}));

mock.module("../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: mockRunBtwSidechain,
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  updateConversationTitle: mockUpdateConversationTitle,
}));

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: mockGetConfiguredProvider,
}));

mock.module("../config/loader.js", () => ({
  getConfig: mockGetConfig,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  generateAndPersistConversationTitle,
  regenerateConversationTitle,
} from "../memory/conversation-title-service.js";

describe("conversation-title-service", () => {
  beforeEach(() => {
    mockRunBtwSidechain.mockClear();
    mockGetConversation.mockClear();
    mockGetMessages.mockClear();
    mockUpdateConversationTitle.mockClear();
    mockGetConfiguredProvider.mockClear();
    mockGetConfig.mockClear();
  });

  test("uses the BTW side-chain helper for initial title generation", async () => {
    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("provider.sendMessage should not be called directly");
      }),
    };

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "Help me plan the kickoff",
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(mockRunBtwSidechain).toHaveBeenCalledTimes(1);
    expect(mockRunBtwSidechain).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        maxTokens: 37,
        modelIntent: "latency-optimized",
        timeoutMs: 10_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
  });

  test("uses the BTW side-chain helper for title regeneration", async () => {
    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("provider.sendMessage should not be called directly");
      }),
    };

    const result = await regenerateConversationTitle({
      conversationId: "conv-1",
      provider,
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(mockRunBtwSidechain).toHaveBeenCalledTimes(1);
    expect(mockRunBtwSidechain).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        maxTokens: 37,
        modelIntent: "latency-optimized",
        timeoutMs: 10_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
  });
});
