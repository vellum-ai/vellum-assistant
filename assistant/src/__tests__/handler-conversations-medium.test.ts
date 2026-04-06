import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createMockConversation,
  createTestHandlerContext,
  noopLogger,
} from "./handlers/handler-test-helpers.js";

// ── Mock state ──────────────────────────────────────────────────────────────

const mockGetConversation = mock();
const mockResolveConversationId = mock((id: string) => id);
const mockPendingResolve = mock();
const mockAbortAllForParent = mock();

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
  getConversation: mockGetConversation,
  updateConversationTitle: mock(() => {}),
  batchSetDisplayOrders: mock(() => {}),
  clearAll: mock(() => {}),
  createConversation: mock(() => ({ id: "conv-new" })),
  addMessage: mock(async () => ({ id: "msg-1" })),
}));

mock.module("../memory/conversation-key-store.js", () => ({
  resolveConversationId: mockResolveConversationId,
}));

mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating...",
  UNTITLED_FALLBACK: "Untitled",
  queueGenerateConversationTitle: mock(() => {}),
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: mock(() => {}),
  resolve: mockPendingResolve,
  getByConversation: mock(() => []),
}));

mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (s: string) => s,
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: mock(() => {}),
  generateCanonicalRequestCode: () => "ABC123",
}));

mock.module("../subagent/index.js", () => ({
  getSubagentManager: () => ({ abortAllForParent: mockAbortAllForParent }),
}));

mock.module("../tools/tool-input-summary.js", () => ({
  summarizeToolInput: () => "summary",
}));

mock.module("../util/truncate.js", () => ({
  truncate: (s: string) => s,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  cancelGeneration,
  handleConfirmationResponse,
  handleConversationSwitch,
  handleSecretResponse,
  handleUndo,
  undoLastMessage,
} from "../daemon/handlers/conversations.js";
import { pendingStandaloneSecrets } from "../daemon/handlers/shared.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleConversationSwitch", () => {
  beforeEach(() => {
    mockGetConversation.mockReset();
  });

  test("sends conversation_info for existing conversation", async () => {
    mockGetConversation.mockReturnValue({
      id: "conv-1",
      title: "My Chat",
      conversationType: null,
    });
    const mockGetOrCreate = mock(async () => createMockConversation());
    const { ctx, sent } = createTestHandlerContext({
      getOrCreateConversation: mockGetOrCreate as any,
    });

    await handleConversationSwitch(
      { type: "conversation_switch", conversationId: "conv-1" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("conversation_info");
    expect(sent[0].conversationId).toBe("conv-1");
    expect(sent[0].title).toBe("My Chat");
    expect(sent[0].conversationType).toBe("standard");
    expect(mockGetOrCreate).toHaveBeenCalledTimes(1);
  });

  test("sends error for non-existent conversation", async () => {
    mockGetConversation.mockReturnValue(undefined);
    const { ctx, sent } = createTestHandlerContext();

    await handleConversationSwitch(
      { type: "conversation_switch", conversationId: "conv-missing" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).toContain("conv-missing");
  });

  test("null title defaults to 'Untitled'", async () => {
    mockGetConversation.mockReturnValue({
      id: "conv-1",
      title: null,
      conversationType: null,
    });
    const { ctx, sent } = createTestHandlerContext({
      getOrCreateConversation: mock(async () =>
        createMockConversation(),
      ) as any,
    });

    await handleConversationSwitch(
      { type: "conversation_switch", conversationId: "conv-1" },
      ctx,
    );

    expect(sent[0].title).toBe("Untitled");
  });

  test("headless-locked conversation still loads via getOrCreateConversation", async () => {
    mockGetConversation.mockReturnValue({
      id: "conv-1",
      title: "Locked",
      conversationType: null,
    });
    const mockGetOrCreate = mock(async () => createMockConversation());
    const { ctx, sent } = createTestHandlerContext({
      getOrCreateConversation: mockGetOrCreate as any,
    });
    // Put a headless-locked conversation in the map
    ctx.conversations.set(
      "conv-1",
      createMockConversation({ headlessLock: true }) as any,
    );

    await handleConversationSwitch(
      { type: "conversation_switch", conversationId: "conv-1" },
      ctx,
    );

    expect(mockGetOrCreate).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("conversation_info");
  });
});

describe("handleConfirmationResponse", () => {
  beforeEach(() => {
    mockPendingResolve.mockReset();
  });

  test("routes to correct conversation by requestId", () => {
    const mockHandleConfirmation = mock(() => {});
    const conv = createMockConversation({
      hasPendingConfirmation: (id: string) => id === "req-42",
      handleConfirmationResponse: mockHandleConfirmation,
    });
    const touchMock = mock(() => {});
    const { ctx } = createTestHandlerContext({
      touchConversation: touchMock,
    });
    ctx.conversations.set("conv-1", conv as any);

    handleConfirmationResponse(
      {
        type: "confirmation_response",
        requestId: "req-42",
        decision: "allow",
      },
      ctx,
    );

    expect(mockHandleConfirmation).toHaveBeenCalledTimes(1);
    expect(mockHandleConfirmation).toHaveBeenCalledWith(
      "req-42",
      "allow",
      undefined,
      undefined,
      undefined,
      { source: "button" },
    );
    expect(mockPendingResolve).toHaveBeenCalledWith("req-42");
  });

  test("no matching conversation logs warning without crashing", () => {
    const { ctx, sent } = createTestHandlerContext();
    // No conversations in the map

    handleConfirmationResponse(
      {
        type: "confirmation_response",
        requestId: "req-orphan",
        decision: "deny",
      },
      ctx,
    );

    // Should not crash or send any messages
    expect(sent).toHaveLength(0);
    expect(mockPendingResolve).not.toHaveBeenCalled();
  });

  test("touches the conversation that owns the pending request", () => {
    const conv = createMockConversation({
      hasPendingConfirmation: () => true,
    });
    const touchMock = mock(() => {});
    const { ctx } = createTestHandlerContext({
      touchConversation: touchMock,
    });
    ctx.conversations.set("conv-1", conv as any);

    handleConfirmationResponse(
      {
        type: "confirmation_response",
        requestId: "req-1",
        decision: "allow",
      },
      ctx,
    );

    expect(touchMock).toHaveBeenCalledWith("conv-1");
  });
});

describe("handleSecretResponse", () => {
  beforeEach(() => {
    mockPendingResolve.mockReset();
    pendingStandaloneSecrets.clear();
  });

  test("standalone secret resolves pending and clears timeout", () => {
    const resolveFn = mock(() => {});
    const timer = setTimeout(() => {}, 60000);
    pendingStandaloneSecrets.set("req-standalone", {
      resolve: resolveFn,
      timer,
    });
    const { ctx } = createTestHandlerContext();

    handleSecretResponse(
      {
        type: "secret_response",
        requestId: "req-standalone",
        value: "my-secret-value",
        delivery: "store",
      },
      ctx,
    );

    expect(resolveFn).toHaveBeenCalledWith({
      value: "my-secret-value",
      delivery: "store",
    });
    expect(pendingStandaloneSecrets.has("req-standalone")).toBe(false);
    expect(mockPendingResolve).toHaveBeenCalledWith("req-standalone");
  });

  test("conversation secret routes to correct conversation", () => {
    const mockHandleSecret = mock(() => {});
    const conv = createMockConversation({
      hasPendingSecret: (id: string) => id === "req-conv",
      handleSecretResponse: mockHandleSecret,
    });
    const { ctx } = createTestHandlerContext();
    ctx.conversations.set("conv-1", conv as any);

    handleSecretResponse(
      {
        type: "secret_response",
        requestId: "req-conv",
        value: "secret-123",
        delivery: "transient_send",
      },
      ctx,
    );

    expect(mockHandleSecret).toHaveBeenCalledWith(
      "req-conv",
      "secret-123",
      "transient_send",
    );
    expect(mockPendingResolve).toHaveBeenCalledWith("req-conv");
  });

  test("no match logs warning without crashing", () => {
    const { ctx, sent } = createTestHandlerContext();

    handleSecretResponse(
      {
        type: "secret_response",
        requestId: "req-orphan",
        value: "x",
      },
      ctx,
    );

    expect(sent).toHaveLength(0);
    expect(mockPendingResolve).not.toHaveBeenCalled();
  });

  test("defaults delivery to 'store' when not provided for standalone", () => {
    const resolveFn = mock(() => {});
    const timer = setTimeout(() => {}, 60000);
    pendingStandaloneSecrets.set("req-default", {
      resolve: resolveFn,
      timer,
    });
    const { ctx } = createTestHandlerContext();

    handleSecretResponse(
      {
        type: "secret_response",
        requestId: "req-default",
        value: "v",
      },
      ctx,
    );

    expect(resolveFn).toHaveBeenCalledWith({
      value: "v",
      delivery: "store",
    });
  });
});

describe("cancelGeneration", () => {
  beforeEach(() => {
    mockAbortAllForParent.mockReset();
  });

  test("active conversation: calls abort and subagent abort, returns true", () => {
    const abortMock = mock(() => {});
    const conv = createMockConversation({ abort: abortMock });
    const touchMock = mock(() => {});
    const { ctx } = createTestHandlerContext({
      touchConversation: touchMock,
    });
    ctx.conversations.set("conv-1", conv as any);

    const result = cancelGeneration("conv-1", ctx);

    expect(result).toBe(true);
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(mockAbortAllForParent).toHaveBeenCalledWith("conv-1");
  });

  test("non-existent conversation returns false", () => {
    const { ctx } = createTestHandlerContext();

    const result = cancelGeneration("conv-missing", ctx);

    expect(result).toBe(false);
    expect(mockAbortAllForParent).not.toHaveBeenCalled();
  });

  test("touches the conversation before aborting", () => {
    const conv = createMockConversation();
    const touchMock = mock(() => {});
    const { ctx } = createTestHandlerContext({
      touchConversation: touchMock,
    });
    ctx.conversations.set("conv-1", conv as any);

    cancelGeneration("conv-1", ctx);

    expect(touchMock).toHaveBeenCalledWith("conv-1");
  });
});

describe("undoLastMessage", () => {
  beforeEach(() => {
    mockResolveConversationId.mockReset();
    mockResolveConversationId.mockImplementation((id: string) => id);
  });

  test("existing conversation calls undo and returns removedCount", async () => {
    const undoMock = mock(() => 3);
    const conv = createMockConversation({ undo: undoMock });
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    const result = await undoLastMessage("conv-1", ctx);

    expect(result).toEqual({ removedCount: 3 });
    expect(undoMock).toHaveBeenCalledTimes(1);
  });

  test("resolves conversation key to internal ID", async () => {
    mockResolveConversationId.mockReturnValue("internal-id");
    const conv = createMockConversation({ undo: mock(() => 1) });
    const mockGetOrCreate = mock(async () => conv);
    const { ctx } = createTestHandlerContext({
      getOrCreateConversation: mockGetOrCreate as any,
    });

    await undoLastMessage("external-key", ctx);

    expect(mockResolveConversationId).toHaveBeenCalledWith("external-key");
    expect(mockGetOrCreate).toHaveBeenCalledWith("internal-id");
  });

  test("returns null when conversation key cannot be resolved", async () => {
    mockResolveConversationId.mockReturnValue(undefined as any);
    const { ctx } = createTestHandlerContext();

    const result = await undoLastMessage("bad-key", ctx);

    expect(result).toBeNull();
  });
});

describe("handleUndo", () => {
  beforeEach(() => {
    mockResolveConversationId.mockReset();
    mockResolveConversationId.mockImplementation((id: string) => id);
  });

  test("existing conversation sends undo_complete", async () => {
    const conv = createMockConversation({ undo: mock(() => 2) });
    const { ctx, sent } = createTestHandlerContext({
      getOrCreateConversation: mock(async () => conv) as any,
    });

    await handleUndo({ type: "undo", conversationId: "conv-1" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("undo_complete");
    expect(sent[0].removedCount).toBe(2);
    expect(sent[0].conversationId).toBe("conv-1");
  });

  test("not found sends error", async () => {
    mockResolveConversationId.mockReturnValue(undefined as any);
    const { ctx, sent } = createTestHandlerContext();

    await handleUndo({ type: "undo", conversationId: "conv-missing" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).toContain("No active conversation");
  });
});
