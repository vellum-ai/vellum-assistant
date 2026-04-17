/**
 * Unit tests for the GET /v1/suggestion endpoint (handleGetSuggestion).
 *
 * Validates happy path, all null-return paths, caching, staleness check,
 * quote stripping, empty response rejection, and modelIntent verification.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const mockGetConversationByKey = mock(
  (_key: string): { conversationId: string } | null => ({
    conversationId: "conv-test",
  }),
);

mock.module("../memory/conversation-key-store.js", () => ({
  getConversationByKey: mockGetConversationByKey,
}));

const mockGetMessages = mock((_conversationId: string) => [
  {
    id: "msg-user-1",
    conversationId: "conv-test",
    role: "user",
    content: JSON.stringify([{ type: "text", text: "Hello there" }]),
    createdAt: Date.now() - 2000,
    metadata: null,
  },
  {
    id: "msg-asst-1",
    conversationId: "conv-test",
    role: "assistant",
    content: JSON.stringify([
      { type: "text", text: "Hi! How can I help you today?" },
    ]),
    createdAt: Date.now() - 1000,
    metadata: null,
  },
]);

mock.module("../memory/conversation-crud.js", () => ({
  getMessages: mockGetMessages,
}));

const mockGetConfiguredProvider = mock(async () => ({
  name: "test-provider",
  sendMessage: mock(async () => ({
    content: [{ type: "text", text: "Let's do round two!" }],
    model: "test",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  })),
}));

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: mockGetConfiguredProvider,
}));

mock.module("../daemon/handlers/shared.js", () => ({
  renderHistoryContent: (content: unknown) => {
    // Extract text from content blocks, mirroring the real function
    if (Array.isArray(content)) {
      const texts = content
        .filter((b: { type: string }) => b.type === "text" && "text" in b)
        .map((b: { text: string }) => b.text);
      return {
        text: texts.join("\n"),
        toolCalls: [],
        toolCallsBeforeText: false,
        textSegments: [],
        contentOrder: [],
        surfaces: [],
        thinkingSegments: [],
      };
    }
    return {
      text: typeof content === "string" ? content : "",
      toolCalls: [],
      toolCallsBeforeText: false,
      textSegments: [],
      contentOrder: [],
      surfaces: [],
      thinkingSegments: [],
    };
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { handleGetSuggestion } from "../runtime/routes/conversation-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUrl(params: {
  conversationKey?: string;
  messageId?: string;
}): URL {
  const url = new URL("http://localhost/v1/suggestion");
  if (params.conversationKey) {
    url.searchParams.set("conversationKey", params.conversationKey);
  }
  if (params.messageId) {
    url.searchParams.set("messageId", params.messageId);
  }
  return url;
}

function makeDeps() {
  return {
    suggestionCache: new Map<string, string>(),
    suggestionInFlight: new Map<string, Promise<string | null>>(),
  };
}

function makeMockProvider(text: string) {
  return {
    name: "test-provider",
    sendMessage: mock(async () => ({
      content: [{ type: "text" as const, text }],
      model: "test",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/suggestion", () => {
  test("returns suggestion from LLM", async () => {
    const provider = makeMockProvider("Let's do round two!");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-user-1",
        conversationId: "conv-test",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Hello" }]),
        createdAt: Date.now() - 2000,
        metadata: null,
      },
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Hi! How can I help you today?" },
        ]),
        createdAt: Date.now() - 1000,
        metadata: null,
      },
    ]);

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);
    const body = (await res.json()) as {
      suggestion: string;
      source: string;
    };

    expect(body.suggestion).toBe("Let's do round two!");
    expect(body.source).toBe("llm");
  });

  test("returns null when no conversation found", async () => {
    mockGetConversationByKey.mockImplementation(() => null);

    const url = makeUrl({ conversationKey: "nonexistent-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);
    const body = (await res.json()) as { suggestion: string | null };

    expect(body.suggestion).toBeNull();
  });

  test("returns null when no messages", async () => {
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => []);

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);
    const body = (await res.json()) as { suggestion: string | null };

    expect(body.suggestion).toBeNull();
  });

  test("returns null when provider unavailable", async () => {
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello there" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);
    mockGetConfiguredProvider.mockImplementation(
      async () =>
        null as unknown as Awaited<
          ReturnType<typeof mockGetConfiguredProvider>
        >,
    );

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);
    const body = (await res.json()) as { suggestion: string | null };

    expect(body.suggestion).toBeNull();
  });

  test("returns null when provider throws", async () => {
    const throwingProvider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("Provider error");
      }),
    };
    mockGetConfiguredProvider.mockImplementation(async () => throwingProvider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello there" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);

    // Should return null gracefully, not a 500
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestion: string | null };
    expect(body.suggestion).toBeNull();
  });

  test("strips quotes from LLM response", async () => {
    const provider = makeMockProvider('"Sure, let\'s go!"');
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello there" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);
    const body = (await res.json()) as { suggestion: string };

    expect(body.suggestion).toBe("Sure, let's go!");
  });

  test("rejects empty LLM response", async () => {
    const provider = makeMockProvider("");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello there" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);
    const body = (await res.json()) as { suggestion: string | null };

    expect(body.suggestion).toBeNull();
  });

  test("returns cached suggestion", async () => {
    const provider = makeMockProvider("Fresh suggestion");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-cache",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Some response" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();

    // First call — should hit the LLM
    const res1 = await handleGetSuggestion(url, deps);
    const body1 = (await res1.json()) as { suggestion: string };
    expect(body1.suggestion).toBe("Fresh suggestion");

    // Second call — should return from cache
    const res2 = await handleGetSuggestion(url, deps);
    const body2 = (await res2.json()) as { suggestion: string };
    expect(body2.suggestion).toBe("Fresh suggestion");

    // Provider sendMessage should have been called only once
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("returns stale when messageId doesn't match", async () => {
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-latest",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Latest response" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const url = makeUrl({
      conversationKey: "test-key",
      messageId: "msg-asst-old",
    });
    const deps = makeDeps();
    const res = await handleGetSuggestion(url, deps);
    const body = (await res.json()) as {
      suggestion: string | null;
      stale: boolean;
    };

    expect(body.stale).toBe(true);
    expect(body.suggestion).toBeNull();
  });

  test("uses conversationStarters call site", async () => {
    const provider = makeMockProvider("Quick reply");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-intent",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello!" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const url = makeUrl({ conversationKey: "test-key" });
    const deps = makeDeps();
    await handleGetSuggestion(url, deps);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = provider.sendMessage.mock.calls[0] as unknown[];
    const options = callArgs[3] as
      | { config?: { callSite?: string } }
      | undefined;
    expect(options?.config?.callSite).toBe("conversationStarters");
  });
});
