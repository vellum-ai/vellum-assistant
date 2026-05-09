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

function makeArgs(params: { conversationKey?: string; messageId?: string }) {
  const queryParams: Record<string, string> = {};
  if (params.conversationKey)
    queryParams.conversationKey = params.conversationKey;
  if (params.messageId) queryParams.messageId = params.messageId;
  return { queryParams };
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

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as {
      suggestion: string;
      source: string;
    };

    expect(body.suggestion).toBe("Let's do round two!");
    expect(body.source).toBe("llm");
  });

  test("returns null when no conversation found", async () => {
    mockGetConversationByKey.mockImplementation(() => null);

    const args = makeArgs({ conversationKey: "nonexistent-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as { suggestion: string | null };

    expect(body.suggestion).toBeNull();
  });

  test("returns null when no messages", async () => {
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => []);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as { suggestion: string | null };

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

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as { suggestion: string | null };

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

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);

    // Should return null gracefully, not a 500
    const body = res as { suggestion: string | null };
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

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as { suggestion: string };

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

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as { suggestion: string | null };

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

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();

    // First call — should hit the LLM
    const res1 = await handleGetSuggestion(args, deps);
    const body1 = res1 as { suggestion: string };
    expect(body1.suggestion).toBe("Fresh suggestion");

    // Second call — should return from cache
    const res2 = await handleGetSuggestion(args, deps);
    const body2 = res2 as { suggestion: string };
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

    const args = makeArgs({
      conversationKey: "test-key",
      messageId: "msg-asst-old",
    });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as {
      suggestion: string | null;
      stale: boolean;
    };

    expect(body.stale).toBe(true);
    expect(body.suggestion).toBeNull();
  });

  test("strips leaked <reply> tags from LLM response", async () => {
    // Realistic output when the model re-emits </reply> before the stop_sequence
    // catches, or when a leading <reply> slips in.
    const provider = makeMockProvider("sounds good</reply>");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Want to go?" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const res = await handleGetSuggestion(args, deps);
    const body = res as { suggestion: string };

    expect(body.suggestion).toBe("sounds good");
  });

  test("passes stop_sequences, max_tokens, and XML-framed user prompt", async () => {
    const provider = makeMockProvider("on my way");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-user-1",
        conversationId: "conv-test",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "heading out" }]),
        createdAt: Date.now() - 1000,
        metadata: null,
      },
      {
        id: "msg-asst-shape",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "see you there — which door?" },
        ]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    await handleGetSuggestion(args, deps);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = provider.sendMessage.mock.calls[0] as unknown[];
    const messages = callArgs[0] as Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }>;
    const options = callArgs[3] as {
      config?: {
        stop_sequences?: string[];
        max_tokens?: number;
      };
    };

    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("user");
    expect(options.config?.stop_sequences).toEqual(["</reply>"]);
    expect(options.config?.max_tokens).toBe(60);
    expect(messages[0].content[0].text).toContain("<assistant_message>");
    expect(messages[0].content[0].text).toContain("<user_message>");
  });

  test("includes prior user message in prompt when present", async () => {
    const provider = makeMockProvider("on my way");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-user-1",
        conversationId: "conv-test",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "running late, should I grab coffee?" },
        ]),
        createdAt: Date.now() - 1000,
        metadata: null,
      },
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "yes please, an americano would be great" },
        ]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    await handleGetSuggestion(args, deps);

    const callArgs = provider.sendMessage.mock.calls[0] as unknown[];
    const messages = callArgs[0] as Array<{
      content: Array<{ text: string }>;
    }>;
    const userPrompt = messages[0].content[0].text;
    expect(userPrompt).toContain(
      "<user_message>running late, should I grab coffee?</user_message>",
    );
    expect(userPrompt).toContain(
      "<assistant_message>yes please, an americano would be great</assistant_message>",
    );
  });

  test("uses placeholder when no prior user message exists", async () => {
    const provider = makeMockProvider("sure");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-first",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "hi there!" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    await handleGetSuggestion(args, deps);

    const callArgs = provider.sendMessage.mock.calls[0] as unknown[];
    const messages = callArgs[0] as Array<{
      content: Array<{ text: string }>;
    }>;
    const userPrompt = messages[0].content[0].text;
    expect(userPrompt).toContain(
      "<user_message>(no prior user message)</user_message>",
    );
  });

  test("uses replySuggestion call site", async () => {
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

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    await handleGetSuggestion(args, deps);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = provider.sendMessage.mock.calls[0] as unknown[];
    const options = callArgs[3] as
      | { config?: { callSite?: string } }
      | undefined;
    expect(options?.config?.callSite).toBe("replySuggestion");
  });

  test("disables thinking and zeros effort to avoid Anthropic temp/thinking 400", async () => {
    // Regression guard: this call hardcodes `temperature: 0.7` for response
    // variety. Anthropic 400s on `temperature` ≠ 1 whenever thinking is
    // enabled or in adaptive mode, so any user profile that resolves
    // thinking-enabled (Opus 4.x at `effort: high|xhigh`, etc.) would fail
    // unless we explicitly opt out of thinking on this call site.
    //
    // Pinning `thinking: { type: "disabled" }` and `effort: "none"` ensures
    // the call works on every profile shape. A 60-token reply chip doesn't
    // benefit from extended thinking anyway.
    const provider = makeMockProvider("Quick reply");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-thinking",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Hello!" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    await handleGetSuggestion(args, deps);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = provider.sendMessage.mock.calls[0] as unknown[];
    const options = callArgs[3] as
      | {
          config?: {
            temperature?: number;
            thinking?: { type?: string };
            effort?: string;
          };
        }
      | undefined;
    expect(options?.config?.temperature).toBe(0.7);
    expect(options?.config?.thinking).toEqual({ type: "disabled" });
    expect(options?.config?.effort).toBe("none");
  });

  test("does not send an assistant-role prefill message", async () => {
    // Regression guard: Anthropic rejects assistant-message prefill
    // whenever the request triggers extended thinking (e.g. Opus 4.x at
    // `effort: "xhigh"`). The suggestion generator must only send a
    // single user-role message so it stays compatible with every
    // possible `replySuggestion` call-site config.
    const provider = makeMockProvider("<reply>Sure, works for me</reply>");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-1",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Want to meet tomorrow?" },
        ]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const response = await handleGetSuggestion(args, deps);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const callArgs = provider.sendMessage.mock.calls[0] as unknown[];
    const messages = callArgs[0] as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages.every((m) => m.role === "user")).toBe(true);

    // Tag-wrapped response is extracted back to just the reply text.
    const body = response as { suggestion: string | null };
    expect(body.suggestion).toBe("Sure, works for me");
  });

  test("handles untagged model response by falling back to raw text", async () => {
    // Some non-Anthropic models and some Anthropic configs drop the
    // `<reply>…</reply>` wrapper entirely. The parser must still
    // produce a usable suggestion from the raw text.
    const provider = makeMockProvider("Sounds good to me");
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-untagged",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Want to meet tomorrow?" },
        ]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const response = await handleGetSuggestion(args, deps);

    const body = response as { suggestion: string | null };
    expect(body.suggestion).toBe("Sounds good to me");
  });

  test("extracts reply content when model adds preamble before tag", async () => {
    // Without assistant-role prefill, nothing stops a chatty model from
    // adding a preamble. The parser's tag-extraction step must take the
    // `<reply>…</reply>` span and ignore surrounding commentary.
    const provider = makeMockProvider(
      "Here's a good option:\n\n<reply>Let's do it</reply>",
    );
    mockGetConfiguredProvider.mockImplementation(async () => provider);
    mockGetConversationByKey.mockImplementation(() => ({
      conversationId: "conv-test",
    }));
    mockGetMessages.mockImplementation(() => [
      {
        id: "msg-asst-preamble",
        conversationId: "conv-test",
        role: "assistant",
        content: JSON.stringify([{ type: "text", text: "Ready to ship it?" }]),
        createdAt: Date.now(),
        metadata: null,
      },
    ]);

    const args = makeArgs({ conversationKey: "test-key" });
    const deps = makeDeps();
    const response = await handleGetSuggestion(args, deps);

    const body = response as { suggestion: string | null };
    expect(body.suggestion).toBe("Let's do it");
  });
});
