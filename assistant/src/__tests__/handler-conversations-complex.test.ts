import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createMockConversation,
  createTestHandlerContext,
  noopLogger,
} from "./handlers/handler-test-helpers.js";

// ── Mock state ──────────────────────────────────────────────────────────────

let createdConversationId = "conv-created-1";
const mockCreateConversation = mock(() => ({
  id: createdConversationId,
  title: "New Conversation",
  conversationType: null,
}));
const mockGetConversation = mock();
const mockUpdateConversationTitle = mock();
const mockQueueGenerateConversationTitle = mock();
const mockPendingRegister = mock();
const mockPendingResolve = mock();
const mockCreateCanonicalGuardianRequest = mock();
const mockResolveConversationId = mock((id: string) => id);

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    services: { inference: { model: "test-model" } },
    ui: {},
    timeouts: { permissionTimeoutSec: 5 },
    secretDetection: { allowOneTimeSend: false },
  }),
}));

mock.module("../memory/conversation-crud.js", () => ({
  createConversation: mockCreateConversation,
  getConversation: mockGetConversation,
  updateConversationTitle: mockUpdateConversationTitle,
  batchSetDisplayOrders: mock(() => {}),
  clearAll: mock(() => {}),
  addMessage: mock(async () => ({ id: "msg-1" })),
}));

mock.module("../memory/conversation-key-store.js", () => ({
  resolveConversationId: mockResolveConversationId,
}));

mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating...",
  UNTITLED_FALLBACK: "Untitled",
  queueGenerateConversationTitle: mockQueueGenerateConversationTitle,
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: mockPendingRegister,
  resolve: mockPendingResolve,
  getByConversation: mock(() => []),
}));

mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (s: string) => s,
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: mockCreateCanonicalGuardianRequest,
  generateCanonicalRequestCode: () => "ABC123",
}));

mock.module("../subagent/index.js", () => ({
  getSubagentManager: () => ({ abortAllForParent: mock(() => {}) }),
}));

mock.module("../tools/tool-input-summary.js", () => ({
  summarizeToolInput: () => "summary",
}));

mock.module("../util/truncate.js", () => ({
  truncate: (s: string) => s,
}));

mock.module("../channels/types.js", () => ({
  parseChannelId: (id: string | undefined) => id ?? null,
  parseInterfaceId: (id: string | undefined) => id ?? null,
}));

mock.module("../daemon/host-bash-proxy.js", () => ({
  HostBashProxy: class {
    constructor() {}
  },
}));

mock.module("../daemon/host-file-proxy.js", () => ({
  HostFileProxy: class {
    constructor() {}
  },
}));

mock.module("../daemon/host-cu-proxy.js", () => ({
  HostCuProxy: class {
    constructor() {}
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  handleConversationCreate,
  makeEventSender,
  regenerateResponse,
} from "../daemon/handlers/conversations.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleConversationCreate", () => {
  beforeEach(() => {
    createdConversationId = "conv-created-1";
    mockCreateConversation.mockReset();
    mockCreateConversation.mockReturnValue({
      id: createdConversationId,
      title: "New Conversation",
      conversationType: null,
    });
    mockGetConversation.mockReset();
    mockUpdateConversationTitle.mockReset();
    mockQueueGenerateConversationTitle.mockReset();
    mockPendingRegister.mockReset();
    mockPendingResolve.mockReset();
  });

  test("basic create without initial message sends conversation_info", async () => {
    const conv = createMockConversation();
    const { ctx, sent } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleConversationCreate({ type: "conversation_create" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("conversation_info");
    expect(sent[0].conversationId).toBe("conv-created-1");
    expect(sent[0].title).toBe("New Conversation");
    expect(sent[0].conversationType).toBe("standard");
  });

  test("create with initial message calls processMessage", async () => {
    const processMessageMock = mock(async () => {});
    const conv = createMockConversation({
      processMessage: processMessageMock,
    });
    const { ctx, sent } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleConversationCreate(
      { type: "conversation_create", initialMessage: "Hello!" },
      ctx,
    );

    // conversation_info is sent immediately
    expect(sent[0].type).toBe("conversation_info");
    // processMessage is called (fire-and-forget)
    // Wait briefly for the async call to execute
    await new Promise((r) => setTimeout(r, 50));
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect((processMessageMock.mock.calls[0] as any[])[0]).toBe("Hello!");
  });

  test("create with preactivatedSkillIds calls setPreactivatedSkillIds", async () => {
    const setPreactivatedMock = mock(() => {});
    const conv = createMockConversation({
      setPreactivatedSkillIds: setPreactivatedMock,
    });
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleConversationCreate(
      {
        type: "conversation_create",
        preactivatedSkillIds: ["weather", "browser"],
      },
      ctx,
    );

    expect(setPreactivatedMock).toHaveBeenCalledWith(["weather", "browser"]);
  });

  test("macOS interface sets up host proxies and adds computer-use skill", async () => {
    const setHostBashMock = mock(() => {});
    const setHostFileMock = mock(() => {});
    const setHostCuMock = mock(() => {});
    const addPreactivatedMock = mock(() => {});
    const conv = createMockConversation({
      setHostBashProxy: setHostBashMock,
      setHostFileProxy: setHostFileMock,
      setHostCuProxy: setHostCuMock,
      addPreactivatedSkillId: addPreactivatedMock,
    });
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleConversationCreate(
      {
        type: "conversation_create",
        initialMessage: "Hi",
        transport: { interfaceId: "macos" } as any,
      },
      ctx,
    );

    expect(setHostBashMock).toHaveBeenCalledTimes(1);
    expect(setHostFileMock).toHaveBeenCalledTimes(1);
    expect(setHostCuMock).toHaveBeenCalledTimes(1);
    expect(addPreactivatedMock).toHaveBeenCalledWith("computer-use");
  });

  test("non-desktop interface does not set up host proxies", async () => {
    const setHostBashMock = mock(() => {});
    const conv = createMockConversation({
      setHostBashProxy: setHostBashMock,
    });
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleConversationCreate(
      {
        type: "conversation_create",
        initialMessage: "Hi",
        transport: { interfaceId: "telegram" } as any,
      },
      ctx,
    );

    expect(setHostBashMock).not.toHaveBeenCalled();
  });

  test("initial message triggers title generation", async () => {
    const conv = createMockConversation();
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleConversationCreate(
      { type: "conversation_create", initialMessage: "What is AI?" },
      ctx,
    );

    expect(mockQueueGenerateConversationTitle).toHaveBeenCalledTimes(1);
    const callArgs = mockQueueGenerateConversationTitle.mock.calls[0][0];
    expect(callArgs.conversationId).toBe("conv-created-1");
    expect(callArgs.userMessage).toBe("What is AI?");
  });

  test("processMessage error sends error and sets fallback title", async () => {
    const conv = createMockConversation({
      processMessage: mock(async () => {
        throw new Error("LLM failed");
      }),
    });
    mockGetConversation.mockReturnValue({
      id: "conv-created-1",
      title: "Generating...",
    });
    const { ctx, sent } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleConversationCreate(
      { type: "conversation_create", initialMessage: "Hello" },
      ctx,
    );

    // Wait for the fire-and-forget catch handler
    await new Promise((r) => setTimeout(r, 100));

    const errorMsgs = sent.filter((m) => m.type === "error");
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(errorMsgs[0].message).toContain("Failed to process initial message");

    // Should have set fallback title
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-created-1",
      "Untitled",
    );
  });

  test("with systemPromptOverride passes it to getOrCreateConversation", async () => {
    const conv = createMockConversation();
    const mockGetOrCreate = mock(async () => conv);
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mockGetOrCreate as any,
    });

    await handleConversationCreate(
      {
        type: "conversation_create",
        systemPromptOverride: "You are a pirate.",
      },
      ctx,
    );

    expect(mockGetOrCreate).toHaveBeenCalledTimes(1);
    const options = (mockGetOrCreate.mock.calls[0] as any[])[1];
    expect(options.systemPromptOverride).toBe("You are a pirate.");
  });
});

describe("regenerateResponse", () => {
  beforeEach(() => {
    mockResolveConversationId.mockReset();
    mockResolveConversationId.mockImplementation((id: string) => id);
  });

  test("resolves key, calls regenerate, returns requestId", async () => {
    const regenerateMock = mock(async () => {});
    const traceEmitMock = mock(() => {});
    const conv = createMockConversation({
      regenerate: regenerateMock,
      traceEmitter: { emit: traceEmitMock },
    });
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });
    const sendEvent = mock(() => {});

    const result = await regenerateResponse("conv-1", ctx, sendEvent as any);

    expect(result).not.toBeNull();
    expect(result!.requestId).toBeTruthy();
    expect(regenerateMock).toHaveBeenCalledTimes(1);
  });

  test("returns null when conversation key cannot be resolved", async () => {
    mockResolveConversationId.mockReturnValue(undefined as any);
    const { ctx } = createTestHandlerContext();
    const sendEvent = mock(() => {});

    const result = await regenerateResponse("bad-key", ctx, sendEvent as any);

    expect(result).toBeNull();
  });

  test("error throws after emitting trace error", async () => {
    const traceEmitMock = mock(() => {});
    const conv = createMockConversation({
      regenerate: mock(async () => {
        throw new Error("Provider timeout");
      }),
      traceEmitter: { emit: traceEmitMock },
    });
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });
    const sendEvent = mock(() => {});

    await expect(
      regenerateResponse("conv-1", ctx, sendEvent as any),
    ).rejects.toThrow("Provider timeout");

    // Should have emitted both request_received and request_error
    const emitCalls = traceEmitMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(emitCalls).toContain("request_received");
    expect(emitCalls).toContain("request_error");
  });

  test("touches conversation and updates client", async () => {
    const updateClientMock = mock(() => {});
    const conv = createMockConversation({
      regenerate: mock(async () => {}),
      updateClient: updateClientMock,
      traceEmitter: { emit: mock(() => {}) },
    });
    const touchMock = mock(() => {});
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
      touchConversation: touchMock,
    });
    const sendEvent = mock(() => {});

    await regenerateResponse("conv-1", ctx, sendEvent as any);

    expect(touchMock).toHaveBeenCalledWith("conv-1");
    expect(updateClientMock).toHaveBeenCalledWith(sendEvent, false);
  });
});

describe("makeEventSender", () => {
  beforeEach(() => {
    mockPendingRegister.mockReset();
    mockCreateCanonicalGuardianRequest.mockReset();
  });

  test("confirmation_request registers pending interaction + canonical request", () => {
    const conv = createMockConversation();
    const { ctx, sent } = createTestHandlerContext();
    const sender = makeEventSender({
      ctx,
      conversation: conv as any,
      conversationId: "conv-1",
      sourceChannel: "vellum",
    });

    sender({
      type: "confirmation_request",
      requestId: "req-1",
      toolName: "bash",
      input: { command: "ls" },
      riskLevel: "medium",
    } as any);

    expect(mockPendingRegister).toHaveBeenCalledTimes(1);
    expect(mockPendingRegister.mock.calls[0][0]).toBe("req-1");
    expect(mockCreateCanonicalGuardianRequest).toHaveBeenCalledTimes(1);
    // Event should still be forwarded to ctx.send
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("confirmation_request");
  });

  test("secret_request registers pending interaction", () => {
    const conv = createMockConversation();
    const { ctx, sent } = createTestHandlerContext();
    const sender = makeEventSender({
      ctx,
      conversation: conv as any,
      conversationId: "conv-1",
      sourceChannel: "vellum",
    });

    sender({
      type: "secret_request",
      requestId: "req-secret",
    } as any);

    expect(mockPendingRegister).toHaveBeenCalledTimes(1);
    expect(mockPendingRegister.mock.calls[0][0]).toBe("req-secret");
    expect(mockPendingRegister.mock.calls[0][1].kind).toBe("secret");
    expect(sent).toHaveLength(1);
  });

  test("host_bash_request registers pending interaction", () => {
    const conv = createMockConversation();
    const { ctx } = createTestHandlerContext();
    const sender = makeEventSender({
      ctx,
      conversation: conv as any,
      conversationId: "conv-1",
      sourceChannel: "vellum",
    });

    sender({
      type: "host_bash_request",
      requestId: "req-bash",
    } as any);

    expect(mockPendingRegister).toHaveBeenCalledTimes(1);
    expect(mockPendingRegister.mock.calls[0][1].kind).toBe("host_bash");
  });

  test("host_cu_request registers pending interaction", () => {
    const conv = createMockConversation();
    const { ctx } = createTestHandlerContext();
    const sender = makeEventSender({
      ctx,
      conversation: conv as any,
      conversationId: "conv-1",
      sourceChannel: "vellum",
    });

    sender({
      type: "host_cu_request",
      requestId: "req-cu",
    } as any);

    expect(mockPendingRegister).toHaveBeenCalledTimes(1);
    expect(mockPendingRegister.mock.calls[0][1].kind).toBe("host_cu");
  });

  test("ACP permission request (acpToolKind) skips normal registration", () => {
    const conv = createMockConversation();
    const { ctx, sent } = createTestHandlerContext();
    const sender = makeEventSender({
      ctx,
      conversation: conv as any,
      conversationId: "conv-1",
      sourceChannel: "vellum",
    });

    sender({
      type: "confirmation_request",
      requestId: "req-acp",
      toolName: "some_tool",
      input: {},
      riskLevel: "low",
      acpToolKind: "read",
    } as any);

    // Should NOT register pending interaction or create canonical request
    expect(mockPendingRegister).not.toHaveBeenCalled();
    expect(mockCreateCanonicalGuardianRequest).not.toHaveBeenCalled();
    // But event should still be forwarded
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("confirmation_request");
  });
});
