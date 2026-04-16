import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockRunBtwSidechain = mock(async (_params: Record<string, unknown>) => ({
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
        systemPrompt: expect.stringContaining("conversation titles"),
        tools: [],
        callSite: "conversationTitle",
        timeoutMs: 10_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
  });

  test("regeneration extracts text from JSON content blocks", async () => {
    mockGetMessages.mockReturnValueOnce([
      {
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Help me plan the kickoff" },
        ]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Sure, here's a plan" },
          { type: "tool_use", id: "toolu_1", name: "web_search", input: {} },
        ]),
      },
      {
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Looks good" }]),
      },
    ]);

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    await regenerateConversationTitle({ conversationId: "conv-1", provider });

    // The prompt sent to the sidechain should contain plain text, not raw JSON
    const prompt = (mockRunBtwSidechain.mock.calls[0] as any)?.[0]
      ?.content as string;
    expect(prompt).not.toContain('"type":"text"');
    expect(prompt).not.toContain('"type":"tool_use"');
    // Tool metadata should NOT appear in the title prompt
    expect(prompt).not.toContain("Tool use");
    expect(prompt).not.toContain("web_search");
    expect(prompt).toContain("Help me plan the kickoff");
    expect(prompt).toContain("Sure, here's a plan");
    expect(prompt).toContain("Looks good");
  });

  test("regeneration extracts text from tool_result content blocks", async () => {
    mockGetMessages.mockReturnValueOnce([
      {
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Search for restaurants" },
        ]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "toolu_1", name: "web_search", input: {} },
        ]),
      },
      {
        role: "user",
        content: JSON.stringify([
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Found 3 restaurants nearby",
          },
        ]),
      },
    ]);

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    await regenerateConversationTitle({ conversationId: "conv-1", provider });

    const prompt = (mockRunBtwSidechain.mock.calls[0] as any)?.[0]
      ?.content as string;
    expect(prompt).not.toContain('"type":"tool_result"');
    // Tool-only assistant message should be skipped entirely
    expect(prompt).not.toContain("Tool use");
    expect(prompt).toContain("Search for restaurants");
    expect(prompt).toContain("Found 3 restaurants nearby");
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
        systemPrompt: expect.stringContaining("conversation titles"),
        tools: [],
        callSite: "conversationTitle",
        timeoutMs: 10_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
  });

  test("title prompt content does not contain generation instructions", async () => {
    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("provider.sendMessage should not be called directly");
      }),
    };

    await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "Help me plan the kickoff",
    });

    const call = mockRunBtwSidechain.mock.calls[0]![0] as {
      content: string;
      systemPrompt: string;
    };
    // Instructions should be in systemPrompt, not in content
    expect(call.content).not.toContain("Generate a very short title");
    expect(call.content).not.toContain("do NOT respond");
    expect(call.systemPrompt).toContain("Do NOT respond");
  });
});
