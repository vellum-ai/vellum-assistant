import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createMockConversation,
  createTestHandlerContext,
  noopLogger,
} from "./handlers/handler-test-helpers.js";

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

const mockGetConversation = mock();
const mockUpdateConversationTitle = mock();
const mockBatchSetDisplayOrders = mock();
const mockClearAll = mock();
mock.module("../memory/conversation-crud.js", () => ({
  getConversation: mockGetConversation,
  updateConversationTitle: mockUpdateConversationTitle,
  batchSetDisplayOrders: mockBatchSetDisplayOrders,
  clearAll: mockClearAll,
  createConversation: mock(() => ({ id: "conv-new" })),
  addMessage: mock(async () => ({ id: "msg-1" })),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    services: { inference: { model: "claude-sonnet-4-20250514" } },
    ui: {},
    timeouts: { permissionTimeoutSec: 5 },
    secretDetection: { allowOneTimeSend: false },
  }),
}));

mock.module("../memory/conversation-key-store.js", () => ({
  resolveConversationId: (id: string) => id,
}));

mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating...",
  UNTITLED_FALLBACK: "Untitled",
  queueGenerateConversationTitle: mock(() => {}),
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: mock(() => {}),
  resolve: mock(() => {}),
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
  getSubagentManager: () => ({ abortAllForParent: mock(() => {}) }),
}));

mock.module("../tools/tool-input-summary.js", () => ({
  summarizeToolInput: () => "summary",
}));

mock.module("../util/truncate.js", () => ({
  truncate: (s: string) => s,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  clearAllConversations,
  handleConversationRename,
  handleDeleteQueuedMessage,
  handleReorderConversations,
  handleUsageRequest,
} from "../daemon/handlers/conversations.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleConversationRename", () => {
  beforeEach(() => {
    mockGetConversation.mockReset();
    mockUpdateConversationTitle.mockReset();
  });

  test("renames existing conversation and sends update", () => {
    mockGetConversation.mockReturnValue({ id: "conv-1", title: "Old Title" });

    const { ctx, sent } = createTestHandlerContext();
    handleConversationRename(
      {
        type: "conversation_rename",
        conversationId: "conv-1",
        title: "New Title",
      },
      ctx,
    );

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "New Title",
      0,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("conversation_title_updated");
    expect(sent[0].conversationId).toBe("conv-1");
    expect(sent[0].title).toBe("New Title");
  });

  test("sends error when conversation not found", () => {
    mockGetConversation.mockReturnValue(undefined);

    const { ctx, sent } = createTestHandlerContext();
    handleConversationRename(
      {
        type: "conversation_rename",
        conversationId: "conv-missing",
        title: "New Title",
      },
      ctx,
    );

    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).toContain("conv-missing");
  });

  test("renames with empty string title (no validation)", () => {
    mockGetConversation.mockReturnValue({ id: "conv-1", title: "Old" });

    const { ctx, sent } = createTestHandlerContext();
    handleConversationRename(
      { type: "conversation_rename", conversationId: "conv-1", title: "" },
      ctx,
    );

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith("conv-1", "", 0);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("conversation_title_updated");
    expect(sent[0].title).toBe("");
  });
});

describe("handleUsageRequest", () => {
  beforeEach(() => {
    mockGetConversation.mockReset();
  });

  test("sends usage response for existing conversation", () => {
    mockGetConversation.mockReturnValue({
      id: "conv-1",
      totalInputTokens: 1500,
      totalOutputTokens: 800,
      totalEstimatedCost: 0.042,
    });

    const { ctx, sent } = createTestHandlerContext();
    handleUsageRequest(
      { type: "usage_request", conversationId: "conv-1" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("usage_response");
    expect(sent[0].totalInputTokens).toBe(1500);
    expect(sent[0].totalOutputTokens).toBe(800);
    expect(sent[0].estimatedCost).toBe(0.042);
    expect(sent[0].model).toBe("claude-sonnet-4-20250514");
  });

  test("sends error when conversation not found", () => {
    mockGetConversation.mockReturnValue(undefined);

    const { ctx, sent } = createTestHandlerContext();
    handleUsageRequest(
      { type: "usage_request", conversationId: "conv-missing" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("error");
    expect(sent[0].message).toContain("No active conversation");
  });

  test("sends zero usage when conversation has no activity", () => {
    mockGetConversation.mockReturnValue({
      id: "conv-1",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
    });

    const { ctx, sent } = createTestHandlerContext();
    handleUsageRequest(
      { type: "usage_request", conversationId: "conv-1" },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("usage_response");
    expect(sent[0].totalInputTokens).toBe(0);
    expect(sent[0].totalOutputTokens).toBe(0);
    expect(sent[0].estimatedCost).toBe(0);
  });
});

describe("handleReorderConversations", () => {
  beforeEach(() => {
    mockBatchSetDisplayOrders.mockReset();
  });

  test("calls batchSetDisplayOrders with mapped updates", () => {
    const { ctx } = createTestHandlerContext();
    handleReorderConversations(
      {
        type: "reorder_conversations",
        updates: [
          { conversationId: "c1", displayOrder: 1, isPinned: true },
          { conversationId: "c2", displayOrder: 2, isPinned: false },
        ],
      },
      ctx,
    );

    expect(mockBatchSetDisplayOrders).toHaveBeenCalledTimes(1);
    expect(mockBatchSetDisplayOrders).toHaveBeenCalledWith([
      { id: "c1", displayOrder: 1, isPinned: true },
      { id: "c2", displayOrder: 2, isPinned: false },
    ]);
  });

  test("no-op when updates is not an array", () => {
    const { ctx } = createTestHandlerContext();
    handleReorderConversations(
      { type: "reorder_conversations", updates: undefined as any },
      ctx,
    );

    expect(mockBatchSetDisplayOrders).not.toHaveBeenCalled();
  });

  test("calls with empty array when updates is empty", () => {
    const { ctx } = createTestHandlerContext();
    handleReorderConversations(
      { type: "reorder_conversations", updates: [] },
      ctx,
    );

    expect(mockBatchSetDisplayOrders).toHaveBeenCalledWith([]);
  });

  test("defaults displayOrder to null and isPinned to false", () => {
    const { ctx } = createTestHandlerContext();
    handleReorderConversations(
      {
        type: "reorder_conversations",
        updates: [{ conversationId: "c1" } as any],
      },
      ctx,
    );

    expect(mockBatchSetDisplayOrders).toHaveBeenCalledWith([
      { id: "c1", displayOrder: null, isPinned: false },
    ]);
  });
});

describe("handleDeleteQueuedMessage", () => {
  test("sends message_queued_deleted when message found and removed", () => {
    const conv = createMockConversation({
      removeQueuedMessage: mock(() => true),
    });
    const { ctx, sent } = createTestHandlerContext();
    ctx.conversations.set("conv-1", conv as any);

    handleDeleteQueuedMessage(
      {
        type: "delete_queued_message",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctx,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("message_queued_deleted");
    expect(sent[0].conversationId).toBe("conv-1");
    expect(sent[0].requestId).toBe("req-1");
  });

  test("sends nothing when conversation not found", () => {
    const { ctx, sent } = createTestHandlerContext();

    handleDeleteQueuedMessage(
      {
        type: "delete_queued_message",
        conversationId: "conv-missing",
        requestId: "req-1",
      },
      ctx,
    );

    expect(sent).toHaveLength(0);
  });

  test("sends nothing when message not found in conversation", () => {
    const conv = createMockConversation({
      removeQueuedMessage: mock(() => false),
    });
    const { ctx, sent } = createTestHandlerContext();
    ctx.conversations.set("conv-1", conv as any);

    handleDeleteQueuedMessage(
      {
        type: "delete_queued_message",
        conversationId: "conv-1",
        requestId: "req-nonexistent",
      },
      ctx,
    );

    expect(sent).toHaveLength(0);
  });
});

describe("clearAllConversations", () => {
  beforeEach(() => {
    mockClearAll.mockReset();
  });

  test("clears in-memory and DB conversations, returns count", () => {
    const { ctx } = createTestHandlerContext({
      clearAllConversations: () => 3,
    });

    const count = clearAllConversations(ctx);

    expect(count).toBe(3);
    expect(mockClearAll).toHaveBeenCalledTimes(1);
  });

  test("returns 0 when no conversations exist", () => {
    const { ctx } = createTestHandlerContext({
      clearAllConversations: () => 0,
    });

    const count = clearAllConversations(ctx);

    expect(count).toBe(0);
    expect(mockClearAll).toHaveBeenCalledTimes(1);
  });
});
