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
  // Ensure getOrCreateConversation is never called — BTW must not create
  // persistent conversations.
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

mock.module("../daemon/session-tool-setup.js", () => ({
  buildToolDefinitions: () => MOCK_TOOLS,
}));

const mockCheckIngressForSecrets = mock((content: string) => ({
  blocked: false,
  userNotice: "",
  detectedTypes: [] as string[],
  normalizedContent: content,
}));

mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: mockCheckIngressForSecrets,
}));

const MOCK_SYSTEM_PROMPT = "You are a helpful assistant.";
const mockBuildSystemPrompt = mock(() => MOCK_SYSTEM_PROMPT);

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: mockBuildSystemPrompt,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type {
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import type { AuthContext, Scope } from "../runtime/auth/types.js";
import type { SendMessageDeps } from "../runtime/http-types.js";
import { btwRouteDefinitions } from "../runtime/routes/btw-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_AUTH_CONTEXT: AuthContext = {
  subject: "test-user",
  principalType: "local",
  assistantId: "self",
  scopeProfile: "local_v1",
  scopes: new Set<Scope>(["local.all"]),
  policyEpoch: 0,
};

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

function makeSendMessageDeps(
  session?: ReturnType<typeof makeMockSession>,
): SendMessageDeps {
  const s = session ?? makeMockSession();
  return {
    getOrCreateSession: mock(
      async (_conversationId: string) => s,
    ) as unknown as SendMessageDeps["getOrCreateSession"],
    assistantEventHub: {} as never,
    resolveAttachments: () => [],
  };
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/btw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callHandler(
  body: Record<string, unknown>,
  deps: { sendMessageDeps?: SendMessageDeps },
): Promise<Response> {
  const routes = btwRouteDefinitions(deps);
  const route = routes.find((r) => r.endpoint === "btw" && r.method === "POST");
  if (!route) throw new Error("btw route not found");
  const req = makeRequest(body);
  const url = new URL(req.url);
  return route.handler({
    req,
    url,
    server: null as never,
    authContext: FAKE_AUTH_CONTEXT,
    params: {},
  });
}

async function readStream(response: Response): Promise<string> {
  return await response.text();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/btw", () => {
  // -- Validation (400s) --

  test("returns 400 for missing conversationKey", async () => {
    const res = await callHandler(
      { content: "hello" },
      { sendMessageDeps: makeSendMessageDeps() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("conversationKey");
  });

  test("returns 400 for missing content", async () => {
    const res = await callHandler(
      { conversationKey: "key" },
      { sendMessageDeps: makeSendMessageDeps() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("content");
  });

  test("returns 400 for empty content", async () => {
    const res = await callHandler(
      { conversationKey: "key", content: "" },
      { sendMessageDeps: makeSendMessageDeps() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("content");
  });

  test("returns 422 when content includes a blocked secret", async () => {
    mockCheckIngressForSecrets.mockReturnValueOnce({
      blocked: true,
      userNotice: "Secret detected",
      detectedTypes: ["api_key"],
      normalizedContent: "sk-test-123",
    });

    const provider = makeMockProvider();
    const session = makeMockSession(provider);
    const res = await callHandler(
      { conversationKey: "key", content: "sk-test-123" },
      { sendMessageDeps: makeSendMessageDeps(session) },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      accepted: boolean;
      error: string;
      message: string;
      detectedTypes: string[];
    };
    expect(body.accepted).toBe(false);
    expect(body.error).toBe("secret_blocked");
    expect(body.detectedTypes).toEqual(["api_key"]);
    expect(provider.sendMessage).not.toHaveBeenCalled();
  });

  // -- Service unavailability (503) --

  test("returns 503 when sendMessageDeps is unavailable", async () => {
    const res = await callHandler(
      { conversationKey: "key", content: "hello" },
      { sendMessageDeps: undefined },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  // -- Successful SSE streaming --

  test("streams btw_text_delta SSE events", async () => {
    const res = await callHandler(
      { conversationKey: "key", content: "hello" },
      { sendMessageDeps: makeSendMessageDeps() },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await readStream(res);
    expect(text).toContain(`event: btw_text_delta\ndata: {"text":"hello"}`);
  });

  test("response ends with btw_complete", async () => {
    const res = await callHandler(
      { conversationKey: "key", content: "hello" },
      { sendMessageDeps: makeSendMessageDeps() },
    );
    const text = await readStream(res);
    expect(text).toContain("event: btw_complete\ndata: {}");
  });

  // -- Provider receives correct args --

  test("provider receives session messages + btw user message, system prompt, tools, and tool_choice none", async () => {
    mockBuildSystemPrompt.mockClear();

    const provider = makeMockProvider();
    const session = makeMockSession(provider);
    const deps = makeSendMessageDeps(session);

    const res = await callHandler(
      { conversationKey: "key", content: "  my question  " },
      { sendMessageDeps: deps },
    );
    // Consume the stream to ensure the provider call completes
    await readStream(res);

    expect(provider.sendMessage).toHaveBeenCalledTimes(1);

    const [messages, tools, systemPrompt, options] =
      provider.sendMessage.mock.calls[0];

    // Messages should be session messages + the new user message (trimmed)
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

    // Tools
    expect(tools).toEqual(MOCK_TOOLS);

    // System prompt built by buildSystemPrompt({ excludeBootstrap: true })
    expect(systemPrompt).toBe(MOCK_SYSTEM_PROMPT);
    expect(mockBuildSystemPrompt).toHaveBeenCalledWith({
      excludeBootstrap: true,
    });

    // Options: tool_choice must be "none"
    expect(options!.config!.tool_choice).toEqual({ type: "none" });
  });

  // -- No persistence --

  test("does not persist any messages (addMessage never called)", async () => {
    mockAddMessage.mockClear();

    const res = await callHandler(
      { conversationKey: "key", content: "hello" },
      { sendMessageDeps: makeSendMessageDeps() },
    );
    await readStream(res);

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  // -- session.processing not touched --

  test("session.processing remains unchanged", async () => {
    const session = makeMockSession();
    const deps = makeSendMessageDeps(session);

    // Verify initial state
    expect(session.processing).toBe(false);

    const res = await callHandler(
      { conversationKey: "key", content: "hello" },
      { sendMessageDeps: deps },
    );
    await readStream(res);

    // processing should still be false — the handler never sets it
    expect(session.processing).toBe(false);
  });

  // -- No conversation creation (regression) --

  test("unknown conversationKey does not create a DB conversation", async () => {
    // Simulate a greeting request for a draft thread — no conversation exists.
    mockGetConversationByKey.mockReturnValueOnce(null);

    const session = makeMockSession();
    const deps = makeSendMessageDeps(session);
    const getOrCreateSessionSpy = deps.getOrCreateSession as ReturnType<
      typeof mock
    >;

    const res = await callHandler(
      { conversationKey: "greeting-abc123", content: "Generate a greeting" },
      { sendMessageDeps: deps },
    );
    await readStream(res);

    expect(res.status).toBe(200);

    // Read-only lookup should be called
    expect(mockGetConversationByKey).toHaveBeenCalledWith("greeting-abc123");

    // Session should be created with the raw key (no DB conversation created)
    expect(getOrCreateSessionSpy).toHaveBeenCalledWith("greeting-abc123");
  });

  test("known conversationKey resolves to existing conversation ID", async () => {
    mockGetConversationByKey.mockReturnValueOnce({
      conversationId: "existing-conv-id",
    });

    const session = makeMockSession();
    const deps = makeSendMessageDeps(session);
    const getOrCreateSessionSpy = deps.getOrCreateSession as ReturnType<
      typeof mock
    >;

    const res = await callHandler(
      { conversationKey: "my-conversation-key", content: "What is 2+2?" },
      { sendMessageDeps: deps },
    );
    await readStream(res);

    expect(res.status).toBe(200);
    expect(getOrCreateSessionSpy).toHaveBeenCalledWith("existing-conv-id");
  });
});
