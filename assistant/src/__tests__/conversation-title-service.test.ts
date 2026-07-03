import { beforeEach, describe, expect, mock, test } from "bun:test";

const TITLE_TOOL_NAME = "record_conversation_title";

/** A forced-tool response: the model called `record_conversation_title`. */
function toolResponse(title: string) {
  return {
    content: [
      {
        type: "tool_use",
        id: "toolu_title",
        name: TITLE_TOOL_NAME,
        input: { title },
      },
    ],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "tool_use",
  };
}

/** A plain-text response: the model ignored the forced tool and emitted text. */
function textResponse(text: string) {
  return {
    content: [{ type: "text", text }],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  };
}

function makeProvider(
  // partial ProviderResponse shapes; `any` keeps the stub assignable to Provider.
  impl: (messages: any, options: any) => any = async () =>
    toolResponse("Project kickoff"),
) {
  return {
    name: "test-provider",
    sendMessage: mock(impl),
  };
}

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

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  updateConversationTitle: mockUpdateConversationTitle,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

// The title service imports `getConfiguredProvider` plus the pure response
// helpers (`createTimeout`, `userMessage`, `extractToolUse`, `extractAllText`)
// from this module. Replacing the module means we must re-provide working
// implementations of those helpers — they are stubbed here to mirror the real
// behavior the service depends on.
mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: mockGetConfiguredProvider,
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  userMessage: (text: string) => ({ role: "user", content: text }),
  extractToolUse: (response: { content?: Array<{ type: string }> }) =>
    response?.content?.find((b) => b.type === "tool_use"),
  extractAllText: (response: {
    content?: Array<{ type: string; text?: string }>;
  }) =>
    (response?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" "),
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
  AUTO_TITLE_LLM,
  generateAndPersistConversationTitle,
  queueGenerateConversationTitle,
  regenerateConversationTitle,
  titleMutex,
} from "../persistence/conversation-title-service.js";

describe("conversation-title-service", () => {
  beforeEach(() => {
    mockGetConversation.mockClear();
    mockGetConversation.mockImplementation(
      (_conversationId: string) =>
        ({
          title: "Generating title...",
          isAutoTitle: 1,
        }) as {
          title: string;
          isAutoTitle: number;
        },
    );
    mockGetMessages.mockClear();
    mockGetMessages.mockImplementation(() => [
      { role: "user", content: "first message" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "follow-up" },
    ]);
    mockUpdateConversationTitle.mockClear();
    mockGetConfiguredProvider.mockClear();
    mockGetConfiguredProvider.mockImplementation(async () => null);
    mockPublishConversationTitleChanged.mockClear();
  });

  test("forces the title tool and persists the extracted title", async () => {
    const provider = makeProvider();

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "Help me plan the kickoff",
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);

    const [, options] = provider.sendMessage.mock.calls[0] as [
      unknown,
      {
        tools: Array<{ name: string }>;
        systemPrompt: string;
        config: { callSite: string; tool_choice: unknown };
      },
    ];
    expect(options.config.callSite).toBe("conversationTitle");
    expect(options.config.tool_choice).toEqual({
      type: "tool",
      name: TITLE_TOOL_NAME,
    });
    expect(options.tools).toHaveLength(1);
    expect(options.tools[0].name).toBe(TITLE_TOOL_NAME);
    expect(options.systemPrompt).toContain("conversation titles");

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      AUTO_TITLE_LLM,
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

    const provider = makeProvider();

    await regenerateConversationTitle({ conversationId: "conv-1", provider });

    // The prompt sent to the model should contain plain text, not raw JSON.
    const prompt = (provider.sendMessage.mock.calls[0] as any)?.[0]?.[0]
      ?.content as string;
    expect(prompt).not.toContain('"type":"text"');
    expect(prompt).not.toContain('"type":"tool_use"');
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

    const provider = makeProvider();

    await regenerateConversationTitle({ conversationId: "conv-1", provider });

    const prompt = (provider.sendMessage.mock.calls[0] as any)?.[0]?.[0]
      ?.content as string;
    expect(prompt).not.toContain('"type":"tool_result"');
    expect(prompt).not.toContain("Tool use");
    expect(prompt).toContain("Search for restaurants");
    expect(prompt).toContain("Found 3 restaurants nearby");
  });

  test("forces the title tool for regeneration", async () => {
    const provider = makeProvider();

    const result = await regenerateConversationTitle({
      conversationId: "conv-1",
      provider,
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const [, options] = provider.sendMessage.mock.calls[0] as [
      unknown,
      { config: { callSite: string; tool_choice: unknown } },
    ];
    expect(options.config.callSite).toBe("conversationTitle");
    expect(options.config.tool_choice).toEqual({
      type: "tool",
      name: TITLE_TOOL_NAME,
    });
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      AUTO_TITLE_LLM,
    );
  });

  test("fallback retry skips regeneration after a successful initial title", async () => {
    mockGetConversation.mockReturnValueOnce({
      title: "Project kickoff",
      isAutoTitle: 1,
    });

    const provider = makeProvider();

    const result = await regenerateConversationTitle({
      conversationId: "conv-1",
      provider,
      onlyIfReplaceable: true,
    });

    expect(result).toEqual({ title: "Project kickoff", updated: false });
    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
  });

  test("rejects meta-failure outputs like 'Missing Context' and uses fallback", async () => {
    const provider = makeProvider(async () => toolResponse("Missing Context"));

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
    const provider = makeProvider(async () => toolResponse(bad));

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "something",
    });

    expect(result.title).toBe("Untitled Conversation");
  });

  // The core bug this PR fixes: weak title models emit their reasoning or
  // continue the conversation, and that prose used to get persisted verbatim.
  // These are real leaked titles observed in production.
  test.each([
    "I need to generate a",
    "I'll work through these 22 files systematically.",
    "The user wants a title",
    "The conversation is about cooking",
    "The assistant should summarize this",
    "The title for this chat is unclear",
    "Let me look at the new results",
    "Based on the conversation, this is about cooking.",
    "Here is a title for the conversation",
    "Sure, here's a good title",
    "User: hey baby Assistant: hi",
    "Knowledge base updated.\n\nGenerate a 2-6 word title",
  ])("rejects leaked-prose title from the forced tool: %s", async (prose) => {
    const provider = makeProvider(async () => toolResponse(prose));

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "hey baby",
    });

    expect(result.title).toBe("Untitled Conversation");
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Untitled Conversation",
      AUTO_TITLE_DETERMINISTIC,
    );
  });

  test.each([
    "Auth Middleware Rewrite",
    "Docker Volume Mounts",
    "Onboarding Flow",
    "Morning Check-In",
    "T-Shirt Discussion",
    // Bare noun-phrase titles whose opening words ("the user", "the
    // conversation", "the assistant", "the title") must not be mistaken for
    // leaked reasoning prose. They are legitimate topics and must be accepted.
    "The User Interface Redesign",
    "The Conversation API",
    "The Assistant Onboarding",
    "The Title Bar Bug",
  ])("accepts a clean noun-phrase title: %s", async (good) => {
    const provider = makeProvider(async () => toolResponse(good));

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "x",
    });

    expect(result).toEqual({ title: good, updated: true });
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      good,
      AUTO_TITLE_LLM,
    );
  });

  test("falls back to response text when the model skips the forced tool", async () => {
    // Provider returned plain text (forced tool ignored) with a compliant title.
    const provider = makeProvider(async () => textResponse("Kickoff Planning"));

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "x",
    });

    expect(result).toEqual({ title: "Kickoff Planning", updated: true });
  });

  test("rejects prose in the text-fallback path", async () => {
    const provider = makeProvider(async () =>
      textResponse("I need to generate a title for this conversation"),
    );

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "x",
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

    const provider = makeProvider();

    const result = await regenerateConversationTitle({
      conversationId: "conv-1",
      provider,
    });

    expect(provider.sendMessage).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
    expect(result).toEqual({ title: "Existing Title", updated: false });
  });

  test("title prompt content does not contain generation instructions", async () => {
    const provider = makeProvider();

    await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "Help me plan the kickoff",
    });

    const [messages, options] = provider.sendMessage.mock.calls[0] as [
      Array<{ content: string }>,
      { systemPrompt: string },
    ];
    const content = messages[0].content;
    // Instructions should be in systemPrompt, not in the user content.
    expect(content).not.toContain("Generate a very short title");
    expect(content).not.toContain("do NOT respond");
    expect(options.systemPrompt).toContain("Do NOT respond");
  });

  test("queueGenerateConversationTitle serializes concurrent calls", async () => {
    const callOrder: string[] = [];
    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const provider = makeProvider();
    // First call: blocks until released.
    provider.sendMessage.mockImplementationOnce(async () => {
      callOrder.push("first:start");
      await firstBlocked;
      callOrder.push("first:end");
      return toolResponse("Title One");
    });
    // Second call: resolves immediately.
    provider.sendMessage.mockImplementationOnce(async () => {
      callOrder.push("second:start");
      return toolResponse("Title Two");
    });

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

    // Let microtasks settle — only the first call should have started.
    await new Promise((r) => setTimeout(r, 10));
    expect(callOrder).toEqual(["first:start"]);

    resolveFirst();
    await titleMutex.withLock(async () => {});

    expect(callOrder).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("queue continues processing after a failed call", async () => {
    const provider = makeProvider();
    // First call: throws.
    provider.sendMessage.mockImplementationOnce(async () => {
      throw new Error("provider timeout");
    });
    // Second call: succeeds.
    provider.sendMessage.mockImplementationOnce(async () =>
      toolResponse("Recovery Title"),
    );

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

    // Both calls went through — failure didn't break the chain.
    expect(provider.sendMessage).toHaveBeenCalledTimes(2);
    const firstUpdate = (
      mockUpdateConversationTitle.mock.calls as unknown as Array<
        [string, string, number?]
      >
    ).find((c) => c[0] === "conv-1");
    expect(firstUpdate).toEqual([
      "conv-1",
      "Untitled Conversation",
      AUTO_TITLE_DETERMINISTIC,
    ]);
    const secondUpdate = (
      mockUpdateConversationTitle.mock.calls as unknown as string[][]
    ).find((c) => c[0] === "conv-2" && c[1] === "Recovery Title");
    expect(secondUpdate).toBeTruthy();
  });
});
