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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
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

const mockPublishConversationTitleChanged = mock(
  (_conversationId: string, _title: string) => {},
);
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationTitleChanged: mockPublishConversationTitleChanged,
}));

import {
  AUTO_TITLE_DETERMINISTIC,
  generateAndPersistConversationTitle,
  queueGenerateConversationTitle,
  regenerateConversationTitle,
  titleMutex,
} from "../memory/conversation-title-service.js";

describe("conversation-title-service", () => {
  beforeEach(() => {
    mockRunBtwSidechain.mockClear();
    mockGetConversation.mockClear();
    mockGetMessages.mockClear();
    mockUpdateConversationTitle.mockClear();
    mockGetConfiguredProvider.mockClear();
    mockPublishConversationTitleChanged.mockClear();
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
        timeoutMs: 15_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
    // Emit is service-native: persisting a title broadcasts the update so
    // every title origin (agent loop, bootstrap, voice) updates clients live.
    expect(mockPublishConversationTitleChanged).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
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
        timeoutMs: 15_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
  });

  test("rejects meta-failure outputs like 'Missing Context' and uses fallback", async () => {
    mockRunBtwSidechain.mockImplementationOnce(async () => ({
      text: "Missing Context",
      hadTextDeltas: true,
      response: {
        content: [{ type: "text", text: "Missing Context" }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    }));

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "so about that t-shirt...",
    });

    expect(result.title).toBe("Untitled Conversation");
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Untitled Conversation",
      AUTO_TITLE_DETERMINISTIC,
    );
  });

  test.each([
    "missing context",
    "No Context",
    "Insufficient Context",
    "Unclear Request",
    "No Topic",
    "Empty Conversation",
  ])("rejects meta-failure variant: %s", async (bad) => {
    mockRunBtwSidechain.mockImplementationOnce(async () => ({
      text: bad,
      hadTextDeltas: true,
      response: {
        content: [{ type: "text", text: bad }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    }));

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "something",
    });

    expect(result.title).toBe("Untitled Conversation");
  });

  test("regeneration skips LLM call when recent messages have no extractable text", async () => {
    mockGetMessages.mockReturnValueOnce([
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
        ]),
      },
      {
        role: "user",
        content: JSON.stringify([
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "image", source: {} }],
          },
        ]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "toolu_2", name: "bash", input: {} },
        ]),
      },
    ]);

    mockGetConversation.mockReturnValueOnce({
      title: "Existing Title",
      isAutoTitle: 1,
    });

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    const result = await regenerateConversationTitle({
      conversationId: "conv-1",
      provider,
    });

    expect(mockRunBtwSidechain).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
    expect(result).toEqual({ title: "Existing Title", updated: false });
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

  test("queueGenerateConversationTitle serializes concurrent calls", async () => {
    const callOrder: string[] = [];
    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    // First call: blocks until we release it
    mockRunBtwSidechain.mockImplementationOnce(async () => {
      callOrder.push("first:start");
      await firstBlocked;
      callOrder.push("first:end");
      return {
        text: "Title One",
        hadTextDeltas: true,
        response: {
          content: [{ type: "text", text: "Title One" }],
          model: "test-model",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "end_turn",
        },
      };
    });

    // Second call: resolves immediately
    mockRunBtwSidechain.mockImplementationOnce(async () => {
      callOrder.push("second:start");
      return {
        text: "Title Two",
        hadTextDeltas: true,
        response: {
          content: [{ type: "text", text: "Title Two" }],
          model: "test-model",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "end_turn",
        },
      };
    });

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    // Fire both calls — without serialization both would start immediately
    queueGenerateConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "first message",
    });
    queueGenerateConversationTitle({
      conversationId: "conv-2",
      provider,
      userMessage: "second message",
    });

    // Let microtasks settle — only the first call should have started
    await new Promise((r) => setTimeout(r, 10));
    expect(callOrder).toEqual(["first:start"]);

    // Release the first call
    resolveFirst();
    await titleMutex.withLock(async () => {});

    // Second should have started only after first finished
    expect(callOrder).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("queue continues processing after a failed call", async () => {
    // First call: throws
    mockRunBtwSidechain.mockImplementationOnce(async () => {
      throw new Error("provider timeout");
    });

    // Second call: succeeds
    mockRunBtwSidechain.mockImplementationOnce(async () => ({
      text: "Recovery Title",
      hadTextDeltas: true,
      response: {
        content: [{ type: "text", text: "Recovery Title" }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    }));

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    queueGenerateConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "will fail",
    });
    queueGenerateConversationTitle({
      conversationId: "conv-2",
      provider,
      userMessage: "will succeed",
    });

    await titleMutex.withLock(async () => {});

    // Both calls went through — failure didn't break the chain
    expect(mockRunBtwSidechain).toHaveBeenCalledTimes(2);
    // Second conversation got a proper title
    const secondUpdate = (
      mockUpdateConversationTitle.mock.calls as unknown as string[][]
    ).find((c) => c[0] === "conv-2" && c[1] === "Recovery Title");
    expect(secondUpdate).toBeTruthy();
  });
});
