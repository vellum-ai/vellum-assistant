/**
 * Unit tests for the POST /v1/btw SSE-streaming side-chain endpoint.
 *
 * Validates request validation (400s), service unavailability (503),
 * successful SSE streaming, provider argument passing, no persistence,
 * and no session.processing mutation.
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
    conversationId: "conv-test-123",
  }),
);

mock.module("../memory/conversation-key-store.js", () => ({
  getConversationByKey: mockGetConversationByKey,
  getOrCreateConversation: () => {
    throw new Error(
      "getOrCreateConversation must not be called from btw-routes",
    );
  },
}));

const mockAddMessage = mock(() => {});

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: mockAddMessage,
}));

const MOCK_TOOLS = [
  {
    name: "test_tool",
    description: "A test tool",
    input_schema: { type: "object", properties: {} },
  },
];

mock.module("../daemon/conversation-tool-setup.js", () => ({
  buildToolDefinitions: () => MOCK_TOOLS,
}));

const MOCK_SYSTEM_PROMPT = "You are a helpful assistant.";
const mockBuildSystemPrompt = mock(() => MOCK_SYSTEM_PROMPT);

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: mockBuildSystemPrompt,
}));

mock.module("../prompts/persona-resolver.js", () => ({
  resolvePersonaContext: () => ({
    userPersona: null,
    userSlug: null,
    channelPersona: null,
  }),
  resolveGuardianPersona: () => null,
  resolveChannelPersona: () => null,
  resolveUserPersona: () => null,
  resolveUserSlug: () => null,
}));

mock.module("../runtime/routes/identity-intro-cache.js", () => ({
  getCachedIntro: () => null,
  readWorkspaceIdentityIntro: () => null,
  setCachedIntro: () => {},
  computeIdentityContentHash: () => "test-hash",
}));

// Mock getOrCreateConversation from conversation-store so the handler
// never touches DaemonServer.
const mockGetOrCreateConversation = mock(async (_id: string) =>
  makeMockSession(),
);

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  findConversation: () => undefined,
  findConversationBySurfaceId: () => undefined,
  setConversation: () => {},
  deleteConversation: () => false,
  clearConversations: () => {},
  hasConversation: () => false,
  conversationCount: () => 0,
  allConversations: () => [][Symbol.iterator](),
  conversationEntries: () => [][Symbol.iterator](),
  conversationIds: () => [][Symbol.iterator](),
  getConversationMap: () => new Map(),
  initConversationLifecycle: () => {},
  registerConversationFactory: () => {},
  getOrCreateActiveConversation: mockGetOrCreateConversation,
  getConversationOptions: () => undefined,
  setConversationOptions: () => {},
  mergeConversationOptions: () => {},
  deleteConversationOptions: () => {},
  clearConversationOptions: () => {},
  setCesClientPromise: () => {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type {
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { ROUTES } from "../runtime/routes/btw-routes.js";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../runtime/routes/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(
  onSendMessage?: (
    messages: unknown[],
    tools: unknown[],
    systemPrompt: string | undefined,
    options: SendMessageOptions | undefined,
  ) => Promise<ProviderResponse>,
) {
  const defaultSendMessage = async (
    _messages: unknown[],
    _tools: unknown[],
    _systemPrompt: string | undefined,
    options: SendMessageOptions | undefined,
  ): Promise<ProviderResponse> => {
    options?.onEvent?.({ type: "text_delta", text: "hello" });
    return {
      content: [{ type: "text", text: "hello" }],
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    };
  };

  return {
    name: "test-provider",
    sendMessage: mock(onSendMessage ?? defaultSendMessage),
  };
}

function makeMockSession(
  providerOverride?: ReturnType<typeof makeMockProvider>,
) {
  const provider = providerOverride ?? makeMockProvider();
  return {
    provider,
    systemPrompt: "You are a helpful assistant.",
    processing: false,
    getMessages: () => [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "prior message" }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "prior response" }],
      },
    ],
  };
}

const route = ROUTES.find((r) => r.endpoint === "btw" && r.method === "POST");
if (!route) throw new Error("btw route not found in ROUTES");

async function callHandler(
  body: Record<string, unknown>,
): Promise<{ result: unknown; error?: unknown }> {
  const args: RouteHandlerArgs = {
    body,
    headers: {},
    abortSignal: new AbortController().signal,
  };
  try {
    const result = await route!.handler(args);
    return { result };
  } catch (error) {
    return { result: undefined, error };
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new TextDecoder().decode(
    new Uint8Array(chunks.reduce((a, c) => a + c.length, 0)).buffer
      .byteLength === 0
      ? new Uint8Array(0)
      : Buffer.concat(chunks),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/btw", () => {
  // -- Validation (400s) --

  test("throws BadRequestError for missing conversationKey", async () => {
    const { error } = await callHandler({ content: "hello" });
    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).message).toContain("conversationKey");
  });

  test("throws BadRequestError for missing content", async () => {
    const { error } = await callHandler({ conversationKey: "key" });
    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).message).toContain("content");
  });

  test("throws BadRequestError for empty content", async () => {
    const { error } = await callHandler({
      conversationKey: "key",
      content: "",
    });
    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).message).toContain("content");
  });

  // -- Service unavailability (503) --

  test("throws ServiceUnavailableError when conversation factory fails", async () => {
    mockGetOrCreateConversation.mockImplementationOnce(async () => {
      throw new Error("not initialized");
    });
    const { error } = await callHandler({
      conversationKey: "key",
      content: "hello",
    });
    expect(error).toBeInstanceOf(ServiceUnavailableError);
  });

  // -- Successful SSE streaming --

  test("streams btw_text_delta SSE events", async () => {
    const session = makeMockSession();
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "key",
      content: "hello",
    });
    expect(result).toBeInstanceOf(ReadableStream);

    const text = await readStream(result as ReadableStream<Uint8Array>);
    expect(text).toContain(`event: btw_text_delta\ndata: {"text":"hello"}`);
  });

  test("response ends with btw_complete", async () => {
    const session = makeMockSession();
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "key",
      content: "hello",
    });
    const text = await readStream(result as ReadableStream<Uint8Array>);
    expect(text).toContain("event: btw_complete\ndata: {}");
  });

  // -- Provider receives correct args --

  test("provider receives session messages + btw user message, system prompt, tools, and tool_choice none", async () => {
    mockBuildSystemPrompt.mockClear();

    const provider = makeMockProvider();
    const session = makeMockSession(provider);
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "key",
      content: "  my question  ",
    });
    await readStream(result as ReadableStream<Uint8Array>);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);

    const [messages, tools, systemPrompt, options] =
      provider.sendMessage.mock.calls[0];

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "prior message" }],
    });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "prior response" }],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "my question" }],
    });

    expect(tools).toEqual(MOCK_TOOLS);
    expect(systemPrompt).toBe(MOCK_SYSTEM_PROMPT);
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith({
      channelPersona: null,
      excludeBootstrap: true,
      excludeCustomPrefix: true,
      userPersona: null,
      userSlug: null,
    });
    expect(options!.config!.tool_choice).toEqual({ type: "none" });
    expect(options!.config!.callSite).toBe("identityIntro");
    expect(options!.config!.modelIntent).toBeUndefined();
  });

  test("greeting requests pass callSite: 'emptyStateGreeting'", async () => {
    const provider = makeMockProvider();
    const session = makeMockSession(provider);
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "greeting",
      content: "Generate a greeting",
    });
    await readStream(result as ReadableStream<Uint8Array>);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const [, , , options] = provider.sendMessage.mock.calls[0];
    expect(options!.config!.callSite).toBe("emptyStateGreeting");
  });

  test("identity intro requests pass callSite: 'identityIntro'", async () => {
    const provider = makeMockProvider();
    const session = makeMockSession(provider);
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "identity-intro",
      content: "Generate an intro",
    });
    await readStream(result as ReadableStream<Uint8Array>);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);
    const [, , , options] = provider.sendMessage.mock.calls[0];
    expect(options!.config!.callSite).toBe("identityIntro");
  });

  // -- No persistence --

  test("does not persist any messages (addMessage never called)", async () => {
    mockAddMessage.mockClear();
    const session = makeMockSession();
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "key",
      content: "hello",
    });
    await readStream(result as ReadableStream<Uint8Array>);

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  // -- session.processing not touched --

  test("session.processing remains unchanged", async () => {
    const session = makeMockSession();
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);
    expect(session.processing).toBe(false);

    const { result } = await callHandler({
      conversationKey: "key",
      content: "hello",
    });
    await readStream(result as ReadableStream<Uint8Array>);

    expect(session.processing).toBe(false);
  });

  // -- Conversation key resolution --

  test("unknown conversationKey falls back to raw key", async () => {
    mockGetConversationByKey.mockReturnValueOnce(null);
    const session = makeMockSession();
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "greeting-abc123",
      content: "Generate a greeting",
    });
    await readStream(result as ReadableStream<Uint8Array>);

    expect(mockGetConversationByKey).toHaveBeenCalledWith("greeting-abc123");
    expect(mockGetOrCreateConversation).toHaveBeenCalledWith("greeting-abc123");
  });

  test("known conversationKey resolves to existing conversation ID", async () => {
    mockGetConversationByKey.mockReturnValueOnce({
      conversationId: "existing-conv-id",
    });
    const session = makeMockSession();
    mockGetOrCreateConversation.mockImplementationOnce(async () => session);

    const { result } = await callHandler({
      conversationKey: "my-conversation-key",
      content: "What is 2+2?",
    });
    await readStream(result as ReadableStream<Uint8Array>);

    expect(mockGetOrCreateConversation).toHaveBeenCalledWith(
      "existing-conv-id",
    );
  });
});
