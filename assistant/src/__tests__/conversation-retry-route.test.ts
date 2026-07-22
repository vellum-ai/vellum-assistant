/**
 * Tests for POST /v1/conversations/:id/retry ("retry last assistant turn").
 *
 * Validates that:
 * - The route 202s immediately after synchronously claiming processing and
 *   discarding the tail, then re-runs the agent loop against the anchor
 *   user message (no new user row).
 * - Busy conversations are rejected with 409 without touching processing.
 * - A conversation with no turn-starting user row 422s and unwinds the claim.
 * - The messages-changed sync invalidation is published (origin-less) only
 *   when rows were actually discarded.
 * - Hidden machine-signal anchors re-run as hidden prompts.
 * - A loop failure broadcasts a retryable conversation_error and clears
 *   processing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

mock.module("../daemon/conversation-process.js", () => ({
  formatSummarizeUpToResult: () => "",
  isEchoSuppressedUserMessage: (
    metadata: Record<string, unknown> | undefined,
  ) =>
    metadata?.hidden === true ||
    typeof metadata?.backgroundEventSource === "string",
  isBackgroundEventMetadata: (metadata: Record<string, unknown> | undefined) =>
    typeof metadata?.backgroundEventSource === "string",
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: async () => 0,
  resolveMetaSlashCommand: async () => null,
  switchConversation: async () => null,
  undoLastMessage: async () => null,
}));

const touchConversationMock = mock((_conversationId: string) => {});
mock.module("../daemon/conversation-evictor.js", () => ({
  touchConversation: touchConversationMock,
}));

// Each test configures the primitive's result here.
let discardResult: {
  anchor: MessageRowLike;
  deletedMessageIds: string[];
} | null = null;
const discardMock = mock((_conversationId: string) => discardResult);
mock.module("../daemon/conversation-history.js", () => ({
  discardLastAssistantDisplayTurn: discardMock,
  extractUserPromptText: (content: Array<{ text?: string }>) =>
    content.map((b) => b.text ?? "").join("\n"),
}));

interface MessageRowLike {
  id: string;
  content: Array<{ type: string; text?: string }>;
  metadata: string | null;
}

const getConversationMock = mock((id: string) =>
  id === "conv-retry-test" ? { id } : null,
);

mock.module("../persistence/conversation-crud.js", () => ({
  addMessage: async () => ({ id: "unused", deduplicated: false }),
  archiveConversation: () => true,
  batchSetDisplayOrders: () => {},
  countConversationsByScheduleJobId: () => 0,
  deleteConversation: () => ({ segmentIds: [], deletedSummaryIds: [] }),
  extractImageSourcePaths: () => undefined,
  forkConversation: () => ({ id: "forked" }),
  getConversation: getConversationMock,
  provenanceFromTrustContext: () => ({ provenanceTrustClass: "unknown" }),
  setConversationSurfaced: () => null,
  unarchiveConversation: () => true,
  updateConversationTitle: () => {},
  wipeConversation: () => ({
    segmentIds: [],
    deletedSummaryIds: [],
    cancelledJobCount: 0,
  }),
}));

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({
    conversationId: "conv-retry-test",
    created: false,
  }),
  resolveConversationId: (id: string) => id,
  setConversationKeyIfAbsent: () => {},
}));

mock.module("../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  linkRequestLogsToMessage: () => {},
}));

mock.module("../schedule/schedule-store.js", () => ({
  deleteSchedule: async () => {},
}));

mock.module("../home/feed-writer.js", () => ({
  stripConversationIds: async () => {},
}));

const broadcastEvents: Array<Record<string, unknown>> = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: Record<string, unknown>) => {
    broadcastEvents.push(msg);
  },
}));

mock.module("../runtime/services/conversation-serializer.js", () => ({
  buildConversationDetailResponse: () => null,
}));

const publishConversationMessagesChangedMock = mock(
  (_conversationId: string, _originClientId?: string) => {},
);
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationListAndMetadataChanged: () => {},
  publishConversationListChanged: () => {},
  publishConversationMessagesChanged: publishConversationMessagesChangedMock,
  publishConversationTitleChanged: () => {},
}));

mock.module("../runtime/routes/inference-profile-session-handler.js", () => ({
  setInferenceProfileSession: async () => ({}),
}));

mock.module("../runtime/routes/conversation-list-routes.js", () => ({
  conversationSummarySchema: z.object({}),
}));

const trustContext = { trustClass: "guardian" };
const resolveTrustMock = mock(async (_principalId?: string) => trustContext);
mock.module("../runtime/routes/vellum-actor-trust.js", () => ({
  resolveVellumActorTrustContext: resolveTrustMock,
}));

const resolveActorMock = mock(async (_principalId?: string) => "actor-123");
mock.module("../runtime/local-actor-identity.js", () => ({
  resolveActorPrincipalIdForLocalGuardian: resolveActorMock,
}));

// Each test installs its fake conversation here for the store mock to serve.
let activeConversation: ReturnType<typeof makeConversation>["conversation"];
mock.module("../daemon/conversation-store.js", () => ({
  destroyActiveConversation: () => {},
  getOrCreateConversation: async () => activeConversation,
}));

import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const retryRoute = ROUTES.find(
  (r) => r.operationId === "retryLastAssistantTurn",
)!;
const retryHandler = async (args: Parameters<typeof retryRoute.handler>[0]) =>
  retryRoute.handler(args);

function makeConversation(opts: { processing?: boolean } = {}) {
  let processing = opts.processing ?? false;
  const setProcessing = mock((value: boolean) => {
    processing = value;
  });
  const setTrustContext = mock((_ctx: unknown) => {});
  const loadFromDb = mock(async () => ({ rows: [], rowToHistoryIndex: [] }));
  const runAgentLoop = mock(
    async (
      _content: string,
      _userMessageId: string,
      _options?: Record<string, unknown>,
    ) => {},
  );
  const emitActivityState = mock(
    (_phase: string, _reason: string, _options?: unknown) => {},
  );
  const conversation = {
    conversationId: "conv-retry-test",
    trustContext: undefined,
    currentRequestId: undefined as string | undefined,
    currentTurnSourceActorPrincipalId: undefined as string | undefined,
    abortController: null as AbortController | null,
    isProcessing: () => processing,
    setProcessing,
    setTrustContext,
    loadFromDb,
    runAgentLoop,
    emitActivityState,
  };
  return {
    conversation,
    setProcessing,
    setTrustContext,
    loadFromDb,
    runAgentLoop,
    emitActivityState,
  };
}

function makeRequest(
  conversationId = "conv-retry-test",
  extraHeaders: Record<string, string> = {},
) {
  return new Request(
    `http://localhost/v1/conversations/${conversationId}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
    },
  );
}

function anchorRow(overrides: Partial<MessageRowLike> = {}): MessageRowLike {
  return {
    id: "user-msg-1",
    content: [{ type: "text", text: "the original prompt" }],
    metadata: null,
    ...overrides,
  };
}

/** Flush the fire-and-forget async block (macrotask + queued microtasks). */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  getConversationMock.mockClear();
  discardMock.mockClear();
  publishConversationMessagesChangedMock.mockClear();
  resolveTrustMock.mockClear();
  resolveActorMock.mockClear();
  touchConversationMock.mockClear();
  broadcastEvents.length = 0;
  discardResult = {
    anchor: anchorRow(),
    deletedMessageIds: ["assistant-msg-1"],
  };
});

describe("POST /v1/conversations/:id/retry", () => {
  test("202s, discards the tail, and re-runs the loop from the anchor", async () => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest("conv-retry-test", {
        "X-Vellum-Actor-Principal-Id": "principal-1",
      }),
      { id: "conv-retry-test" },
      202,
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      accepted: true,
      conversationId: "conv-retry-test",
      userMessageId: "user-msg-1",
      discardedCount: 1,
    });

    // Trust is bound from the requesting actor before the turn.
    expect(resolveTrustMock).toHaveBeenCalledWith("principal-1", {
      healResetDrift: true,
    });
    expect(ctx.setTrustContext).toHaveBeenCalledWith(trustContext);
    expect(ctx.conversation.currentTurnSourceActorPrincipalId).toBe(
      "actor-123",
    );

    // The claim landed before the discard and stays held for the loop.
    expect(ctx.setProcessing).toHaveBeenCalledWith(true);
    expect(ctx.conversation.isProcessing()).toBe(true);
    expect(ctx.conversation.abortController).not.toBeNull();
    expect(discardMock).toHaveBeenCalledWith("conv-retry-test");

    // Origin-less invalidation: the initiating client reconciles too.
    expect(publishConversationMessagesChangedMock).toHaveBeenCalledTimes(1);
    expect(publishConversationMessagesChangedMock.mock.calls[0]).toEqual([
      "conv-retry-test",
    ]);

    await settle();

    // In-memory history resyncs to the truncated DB state before the loop.
    expect(ctx.loadFromDb).toHaveBeenCalledTimes(1);
    expect(ctx.emitActivityState).toHaveBeenCalledWith(
      "thinking",
      "message_dequeued",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(ctx.runAgentLoop).toHaveBeenCalledTimes(1);
    const [content, userMessageId, options] = ctx.runAgentLoop.mock.calls[0];
    expect(content).toBe("the original prompt");
    expect(userMessageId).toBe("user-msg-1");
    expect(options).toMatchObject({
      isUserMessage: true,
      isInteractive: true,
    });
    expect(options).not.toHaveProperty("isHiddenPrompt");
    expect(typeof (options as { onEvent?: unknown }).onEvent).toBe("function");
  });

  test("background-event anchor re-runs hidden AND non-interactive", async () => {
    discardResult = {
      anchor: anchorRow({
        metadata: JSON.stringify({ backgroundEventSource: "schedule" }),
      }),
      deletedMessageIds: ["assistant-msg-1"],
    };
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest(),
      { id: "conv-retry-test" },
      202,
    );
    expect(res.status).toBe(202);
    await settle();

    // A scheduled/wake anchor was dispatched non-interactively, so the retry
    // reproduces that background permission mode instead of a foreground chat.
    const [, , options] = ctx.runAgentLoop.mock.calls[0];
    expect(options).toMatchObject({
      isHiddenPrompt: true,
      isInteractive: false,
    });
  });

  test("hidden non-background anchor re-runs hidden but stays interactive", async () => {
    // A hidden `POST /messages` send (e.g. a proactive greeting from the web
    // client) is echo-suppressed but was dispatched interactively — only the
    // background-event marker flips a retry to non-interactive.
    discardResult = {
      anchor: anchorRow({ metadata: JSON.stringify({ hidden: true }) }),
      deletedMessageIds: ["assistant-msg-1"],
    };
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest(),
      { id: "conv-retry-test" },
      202,
    );
    expect(res.status).toBe(202);
    await settle();

    const [, , options] = ctx.runAgentLoop.mock.calls[0];
    expect(options).toMatchObject({
      isHiddenPrompt: true,
      isInteractive: true,
    });
  });

  test("busy conversation → 409 without claiming processing", async () => {
    const ctx = makeConversation({ processing: true });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest(),
      { id: "conv-retry-test" },
      202,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("currently responding");
    expect(ctx.setProcessing).not.toHaveBeenCalled();
    expect(discardMock).not.toHaveBeenCalled();
  });

  test("unknown conversation → 404 before any claim", async () => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest("conv-missing"),
      { id: "conv-missing" },
      202,
    );

    expect(res.status).toBe(404);
    expect(ctx.setProcessing).not.toHaveBeenCalled();
    expect(discardMock).not.toHaveBeenCalled();
  });

  test("no user message to retry from → 422 and the claim unwinds", async () => {
    discardResult = null;
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest(),
      { id: "conv-retry-test" },
      202,
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("No user message to retry from");
    // Claimed, then released: true followed by false, controller cleared.
    expect(ctx.setProcessing.mock.calls.map((c) => c[0])).toEqual([
      true,
      false,
    ]);
    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.conversation.abortController).toBeNull();
    expect(publishConversationMessagesChangedMock).not.toHaveBeenCalled();
  });

  test("empty tail → no invalidation published, loop still re-runs", async () => {
    discardResult = { anchor: anchorRow(), deletedMessageIds: [] };
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest(),
      { id: "conv-retry-test" },
      202,
    );

    expect(res.status).toBe(202);
    expect(
      ((await res.json()) as { discardedCount: number }).discardedCount,
    ).toBe(0);
    expect(publishConversationMessagesChangedMock).not.toHaveBeenCalled();

    await settle();
    expect(ctx.runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("loop failure → retryable conversation_error and processing cleared", async () => {
    const ctx = makeConversation();
    ctx.runAgentLoop.mockImplementationOnce(async () => {
      throw new Error("provider exploded");
    });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      retryHandler,
      makeRequest(),
      { id: "conv-retry-test" },
      202,
    );
    expect(res.status).toBe(202);

    await settle();

    const error = broadcastEvents.find((e) => e.type === "conversation_error");
    expect(error).toBeDefined();
    expect(error?.code).toBe("UNKNOWN");
    expect(error?.retryable).toBe(true);
    expect(String(error?.userMessage)).toContain("provider exploded");
    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.conversation.abortController).toBeNull();
    expect(ctx.emitActivityState).toHaveBeenLastCalledWith(
      "idle",
      "error_terminal",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });
});
