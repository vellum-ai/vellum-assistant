/**
 * Tests for POST /v1/conversations/summarize ("summarize up to here").
 *
 * Validates that:
 * - The route 202s immediately and runs summarization async, persisting a
 *   system-card result row via the canned-message path (message_complete +
 *   sync invalidation, no text delta) exactly like the /compact branch.
 * - Busy conversations are rejected with 409 without touching processing.
 * - Boundary UserErrors surface as a "Summarization skipped" card, not a
 *   conversation_error.
 * - Unexpected errors broadcast a retryable conversation_error.
 * - Processing is cleared and the queue drained on every outcome.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  hasUngatedHttpAuthDisabled: () => false,
}));

const formatSummarizeUpToResultMock = mock(
  (result: { compactedMessages: number }) =>
    `**Conversation summarized**\nSummarized ${result.compactedMessages} earlier messages.`,
);

mock.module("../daemon/conversation-process.js", () => ({
  formatSummarizeUpToResult: formatSummarizeUpToResultMock,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  cancelGeneration: () => true,
  clearAllConversations: async () => 0,
  resolveMetaSlashCommand: async () => null,
  switchConversation: async () => null,
  undoLastMessage: async () => null,
}));

const addMessageMock = mock(
  async (
    _conversationId: string,
    _role: string,
    _content: string,
    _options?: { metadata?: Record<string, unknown> },
  ) => ({ id: "persisted-assistant-id", deduplicated: false }),
);

const getConversationMock = mock((id: string) =>
  id === "conv-summarize-test" ? { id } : null,
);

mock.module("../persistence/conversation-crud.js", () => ({
  addMessage: addMessageMock,
  archiveConversation: () => true,
  batchSetDisplayOrders: () => {},
  countConversationsByScheduleJobId: () => 0,
  deleteConversation: () => ({ segmentIds: [], deletedSummaryIds: [] }),
  extractImageSourcePaths: () => undefined,
  forkConversation: () => ({ id: "forked" }),
  getConversation: getConversationMock,
  provenanceFromTrustContext: (ctx: unknown) =>
    ctx
      ? { provenanceTrustClass: (ctx as Record<string, unknown>).trustClass }
      : { provenanceTrustClass: "unknown" },
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
    conversationId: "conv-summarize-test",
    created: false,
  }),
  resolveConversationId: (id: string) => id,
  setConversationKeyIfAbsent: () => {},
}));

mock.module("../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: () => {},
}));

const linkRequestLogsToMessageMock = mock(
  (_logIds: string[], _messageId: string) => {},
);

mock.module("../persistence/llm-request-log-store.js", () => ({
  linkRequestLogsToMessage: linkRequestLogsToMessageMock,
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

// Each test installs its fake conversation here for the store mock to serve.
let activeConversation: ReturnType<typeof makeConversation>["conversation"];
mock.module("../daemon/conversation-store.js", () => ({
  destroyActiveConversation: () => {},
  getOrCreateConversation: async () => activeConversation,
}));

import { ROUTES } from "../runtime/routes/conversation-management-routes.js";
import { UserError } from "../util/errors.js";
import { callHandler } from "./helpers/call-route-handler.js";

const summarizeRoute = ROUTES.find(
  (r) => r.operationId === "summarizeConversation",
)!;
const summarizeHandler = async (
  args: Parameters<typeof summarizeRoute.handler>[0],
) => summarizeRoute.handler(args);

function makeConversation(opts: { processing?: boolean } = {}) {
  let processing = opts.processing ?? false;
  const setProcessing = mock((value: boolean) => {
    processing = value;
  });
  const summarizeUpToMessage = mock(async (_beforeMessageId: string) => ({
    messages: [],
    compacted: true,
    previousEstimatedInputTokens: 12000,
    estimatedInputTokens: 4000,
    maxInputTokens: 200000,
    thresholdTokens: 160000,
    compactedMessages: 12,
    compactedPersistedMessages: 12,
    preservedTailMessages: 4,
    summaryCalls: 1,
    summaryInputTokens: 500,
    summaryOutputTokens: 100,
    summaryModel: "test-model",
    summaryRequestLogId: "compaction-log-1",
  }));
  const emitActivityState = mock(
    (_phase: string, _reason: string, _options?: { statusText?: string }) => {},
  );
  const drainQueue = mock(async () => {});
  const messages: unknown[] = [];
  const conversation = {
    conversationId: "conv-summarize-test",
    trustContext: undefined,
    isProcessing: () => processing,
    setProcessing,
    summarizeUpToMessage,
    emitActivityState,
    drainQueue,
    getMessages: () => messages,
  };
  return {
    conversation,
    setProcessing,
    summarizeUpToMessage,
    emitActivityState,
    drainQueue,
    messages,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/v1/conversations/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Flush the fire-and-forget async block (macrotask + queued microtasks). */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  addMessageMock.mockClear();
  getConversationMock.mockClear();
  formatSummarizeUpToResultMock.mockClear();
  publishConversationMessagesChangedMock.mockClear();
  broadcastEvents.length = 0;
});

describe("POST /v1/conversations/summarize", () => {
  test("202s immediately, then persists the result card and emits turn events", async () => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      accepted: true,
      conversationId: "conv-summarize-test",
    });

    await settle();

    expect(ctx.summarizeUpToMessage).toHaveBeenCalledWith("msg-42");
    expect(ctx.emitActivityState).toHaveBeenCalledWith(
      "thinking",
      "context_compacting",
      { statusText: "Summarizing conversation" },
    );
    // The thinking activity gets a paired terminal so a client that started
    // an indicator from it always clears.
    expect(ctx.emitActivityState).toHaveBeenLastCalledWith(
      "idle",
      "message_complete",
    );

    // Card persisted as an assistant message and pushed onto in-memory history.
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const [convId, role, content, options] = addMessageMock.mock.calls[0];
    expect(convId).toBe("conv-summarize-test");
    expect(role).toBe("assistant");
    expect(content).toContain("Conversation summarized");
    // Metadata mirrors the /compact card shape (channel keys + provenance)
    // plus the system-card marker that keeps the row a standalone notice;
    // interface keys are omitted because the route receives no interface id.
    expect(options?.metadata).toEqual({
      provenanceTrustClass: "unknown",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      messageKind: "system_card",
    });
    expect(ctx.messages).toHaveLength(1);

    // Cards are announced via message_complete + the messages-changed sync
    // invalidation — never a text delta, which would stream the card into
    // the tail assistant bubble as persona speech.
    const delta = broadcastEvents.find(
      (e) => e.type === "assistant_text_delta",
    );
    expect(delta).toBeUndefined();
    const complete = broadcastEvents.find((e) => e.type === "message_complete");
    expect(complete?.messageId).toBe("persisted-assistant-id");

    // The compaction LLM call is attributed to the card it produced.
    expect(linkRequestLogsToMessageMock).toHaveBeenCalledWith(
      ["compaction-log-1"],
      "persisted-assistant-id",
    );
    expect(publishConversationMessagesChangedMock).toHaveBeenCalledWith(
      "conv-summarize-test",
      undefined,
    );

    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.drainQueue).toHaveBeenCalledTimes(1);
  });

  test("busy conversation → 409 without claiming processing", async () => {
    const ctx = makeConversation({ processing: true });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("currently responding");
    expect(ctx.setProcessing).not.toHaveBeenCalled();
    expect(ctx.summarizeUpToMessage).not.toHaveBeenCalled();
  });

  test("unknown conversation → 404", async () => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-missing",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );

    expect(res.status).toBe(404);
    expect(ctx.summarizeUpToMessage).not.toHaveBeenCalled();
  });

  test("boundary UserError → skipped card, no conversation_error", async () => {
    const ctx = makeConversation();
    ctx.summarizeUpToMessage.mockImplementationOnce(async () => {
      throw new UserError("Nothing to summarize before this message");
    });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-1",
      }),
      undefined,
      202,
    );
    expect(res.status).toBe(202);

    await settle();

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const [, role, content] = addMessageMock.mock.calls[0];
    expect(role).toBe("assistant");
    expect(content).toContain(
      "Summarization skipped — Nothing to summarize before this message",
    );
    expect(broadcastEvents.some((e) => e.type === "conversation_error")).toBe(
      false,
    );
    expect(broadcastEvents.some((e) => e.type === "message_complete")).toBe(
      true,
    );
    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.drainQueue).toHaveBeenCalledTimes(1);
  });

  test("unexpected error → retryable conversation_error, processing cleared", async () => {
    const ctx = makeConversation();
    ctx.summarizeUpToMessage.mockImplementationOnce(async () => {
      throw new Error("summary call exploded");
    });
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest({
        conversationId: "conv-summarize-test",
        beforeMessageId: "msg-42",
      }),
      undefined,
      202,
    );
    expect(res.status).toBe(202);

    await settle();

    expect(addMessageMock).not.toHaveBeenCalled();
    const error = broadcastEvents.find((e) => e.type === "conversation_error");
    expect(error).toBeDefined();
    expect(error?.code).toBe("UNKNOWN");
    expect(error?.retryable).toBe(true);
    expect(String(error?.userMessage)).toContain("summary call exploded");
    // No card means no message_complete — the idle activity emit is the only
    // terminal signal clearing a client-side indicator on this path.
    expect(ctx.emitActivityState).toHaveBeenLastCalledWith(
      "idle",
      "error_terminal",
    );
    expect(ctx.conversation.isProcessing()).toBe(false);
    expect(ctx.drainQueue).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ beforeMessageId: "msg-42" }, "conversationId"],
    [{ conversationId: "conv-summarize-test" }, "beforeMessageId"],
    [{ conversationId: 7, beforeMessageId: "msg-42" }, "conversationId"],
    [
      { conversationId: "conv-summarize-test", beforeMessageId: 7 },
      "beforeMessageId",
    ],
  ])("invalid body %j → 400 mentioning %s", async (body, field) => {
    const ctx = makeConversation();
    activeConversation = ctx.conversation;

    const res = await callHandler(
      summarizeHandler,
      makeRequest(body as Record<string, unknown>),
      undefined,
      202,
    );

    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { message: string } };
    expect(parsed.error.message).toContain(field);
    expect(ctx.setProcessing).not.toHaveBeenCalled();
  });
});
