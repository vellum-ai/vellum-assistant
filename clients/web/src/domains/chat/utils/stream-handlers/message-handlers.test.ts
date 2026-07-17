import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import {
  handleAssistantTextDelta,
  handleAssistantThinkingDelta,
  handleAssistantTurnStart,
  handleAssistantActivityState,
  handleMessageComplete,
  handleUserMessageEcho,
  handleGenerationHandoff,
  handleGenerationCancelled,
} from "@/domains/chat/utils/stream-handlers/message-handlers";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useConversationStore } from "@/stores/conversation-store";
import { conversationsQueryKey } from "@/utils/conversation-list-fetchers";
import { findConversation } from "@/utils/conversation-cache";
import type { Conversation } from "@/types/conversation-types";
import type { DisplayMessage } from "@/domains/chat/types/types";

describe("handleAssistantTurnStart", () => {
  it("seeds currentAssistantMessageIdRef from the event's messageId", () => {
    const ctx = makeCtx();
    handleAssistantTurnStart(
      { type: "assistant_turn_start", messageId: "msg-A" },
      ctx,
    );
    expect(ctx.currentAssistantMessageIdRef.current).toBe("msg-A");
  });

  it("patches the cached conversation's isProcessing to true so 0.8.8+ reads the server flag", () => {
    // GIVEN a cached conversation row the daemon last reported as idle
    const ctx = makeCtx();
    ctx.queryClient.setQueryData<Conversation[]>(
      conversationsQueryKey("ast-1"),
      [{ conversationId: "conv-1", isProcessing: false }],
    );

    // WHEN the daemon emits the turn's first start signal
    handleAssistantTurnStart(
      { type: "assistant_turn_start", messageId: "msg-A" },
      ctx,
    );

    // THEN the cached server-snapshot flag is brought fresh to true — the
    // symmetric counterpart to the terminal handlers' false-patch — so
    // clients reading `conversation.isProcessing` see the live turn
    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(true);
  });
});

describe("handleAssistantTextDelta", () => {
  it("cancels reconciliation and dispatches ASSISTANT_TEXT_DELTA", () => {
    const ctx = makeCtx();
    handleAssistantTextDelta(
      { type: "assistant_text_delta", text: "Hello" },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.turnActions.onTextDelta).toHaveBeenCalled();
  });

  it("flips the cached conversation's isProcessing to true when the start event was missed", () => {
    // GIVEN a cached conversation that never saw assistant_turn_start
    // (e.g. the start event was dropped on a reconnect)
    const ctx = makeCtx();
    ctx.queryClient.setQueryData<Conversation[]>(
      conversationsQueryKey("ast-1"),
      [{ conversationId: "conv-1", isProcessing: false }],
    );

    // WHEN the first text delta lands
    handleAssistantTextDelta(
      { type: "assistant_text_delta", text: "Hello" },
      ctx,
    );

    // THEN the cached server-snapshot flag is brought fresh to true
    expect(
      findConversation(ctx.queryClient, "ast-1", "conv-1")?.isProcessing,
    ).toBe(true);
  });

  it("stamps currentAssistantMessageIdRef from the event's messageId when present", () => {
    // Transcript content is owned by the rolling-snapshot reducer; the
    // handler only stamps the anchor so subagent handlers attribute nested
    // notifications to the right parent bubble.
    const ctx = makeCtx();
    handleAssistantTextDelta(
      { type: "assistant_text_delta", text: "Hello", messageId: "msg-A" },
      ctx,
    );
    expect(ctx.currentAssistantMessageIdRef.current).toBe("msg-A");
  });
});

describe("handleAssistantThinkingDelta", () => {
  it("cancels reconciliation and stamps the anchor from the event's messageId", () => {
    // GIVEN a fresh stream context
    const ctx = makeCtx();

    // WHEN a thinking delta carrying a messageId arrives
    handleAssistantThinkingDelta(
      {
        type: "assistant_thinking_delta",
        thinking: "reasoning",
        messageId: "msg-A",
      },
      ctx,
    );

    // THEN a pending reconcile is cancelled and the current-assistant
    // anchor is stamped (content folds into the snapshot via the reducer)
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.currentAssistantMessageIdRef.current).toBe("msg-A");
  });
});

describe("handleAssistantActivityState", () => {
  it("skips events with stale activityVersion", () => {
    const ctx = makeCtx();
    ctx.lastActivityVersionRef.current.set("conv-1", 5);
    handleAssistantActivityState(
      {
        type: "assistant_activity_state",
        activityVersion: 3,
        phase: "thinking",
        anchor: "assistant_turn",
        reason: "thinking_delta",
        conversationId: "conv-1",
      },
      ctx,
    );
    expect(ctx.turnActions.onActivityThinking).not.toHaveBeenCalled();
    expect(ctx.endTurn).not.toHaveBeenCalled();
  });

  it("updates version and handles idle phase without starting reconcile", () => {
    const ctx = makeCtx();
    handleAssistantActivityState(
      {
        type: "assistant_activity_state",
        activityVersion: 1,
        phase: "idle",
        anchor: "assistant_turn",
        reason: "message_complete",
        conversationId: "conv-1",
      },
      ctx,
    );
    expect(ctx.lastActivityVersionRef.current.get("conv-1")).toBe(1);
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "complete",
    });
    expect(ctx.startReconciliationLoop).not.toHaveBeenCalled();
  });

  it("calls onActivityThinking for thinking phase", () => {
    const ctx = makeCtx();
    handleAssistantActivityState(
      {
        type: "assistant_activity_state",
        activityVersion: 2,
        phase: "thinking",
        anchor: "assistant_turn",
        reason: "tool_result_received",
        conversationId: "conv-1",
      },
      ctx,
    );
    expect(ctx.lastActivityVersionRef.current.get("conv-1")).toBe(2);
    expect(ctx.turnActions.onActivityThinking).toHaveBeenCalledWith(
      undefined,
      { canStartFromIdle: false },
    );
    expect(ctx.startReconciliationLoop).not.toHaveBeenCalled();
  });

  it("forwards statusText in onActivityThinking call", () => {
    const ctx = makeCtx();
    handleAssistantActivityState(
      {
        type: "assistant_activity_state",
        activityVersion: 3,
        phase: "thinking",
        anchor: "assistant_turn",
        reason: "tool_result_received",
        statusText: "Processing bash results",
        conversationId: "conv-1",
      },
      ctx,
    );
    expect(ctx.turnActions.onActivityThinking).toHaveBeenCalledWith(
      "Processing bash results",
      { canStartFromIdle: false },
    );
  });

  it("marks thinking as idle-startable only for the active conversation", () => {
    useConversationStore.getState().setActiveConversationId("conv-1");
    try {
      const ctx = makeCtx();
      handleAssistantActivityState(
        {
          type: "assistant_activity_state",
          activityVersion: 4,
          phase: "thinking",
          anchor: "assistant_turn",
          reason: "context_compacting",
          statusText: "Summarizing conversation",
          conversationId: "conv-1",
        },
        ctx,
      );
      expect(ctx.turnActions.onActivityThinking).toHaveBeenCalledWith(
        "Summarizing conversation",
        { canStartFromIdle: true },
      );

      handleAssistantActivityState(
        {
          type: "assistant_activity_state",
          activityVersion: 1,
          phase: "thinking",
          anchor: "assistant_turn",
          reason: "context_compacting",
          conversationId: "conv-other",
        },
        ctx,
      );
      expect(ctx.turnActions.onActivityThinking).toHaveBeenLastCalledWith(
        undefined,
        { canStartFromIdle: false },
      );
    } finally {
      useConversationStore.getState().setActiveConversationId(null);
    }
  });

  it("returns early for non-idle, non-thinking phase", () => {
    const ctx = makeCtx();
    handleAssistantActivityState(
      {
        type: "assistant_activity_state",
        activityVersion: 1,
        phase: "streaming",
        anchor: "assistant_turn",
        reason: "first_text_delta",
        conversationId: "conv-1",
      },
      ctx,
    );
    expect(
      ctx.lastActivityVersionRef.current.get(
        ctx.streamContext!.conversationId,
      ),
    ).toBe(1);
    expect(ctx.turnActions.onActivityThinking).not.toHaveBeenCalled();
    expect(ctx.endTurn).not.toHaveBeenCalled();
  });
});

describe("handleMessageComplete", () => {
  it("finalizes message and ends the turn without starting reconcile", () => {
    const ctx = makeCtx();
    handleMessageComplete(
      { type: "message_complete", messageId: "msg-1" },
      ctx,
    );
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "complete",
    });
    expect(ctx.startReconciliationLoop).not.toHaveBeenCalled();
  });

  it("prefers event.conversationId over streamContext when both differ", () => {
    // streamContext is a mirror that may be cleared by a stream
    // teardown that races the terminal event. When the event itself
    // carries the canonical conversationId, the handler must use it
    // — otherwise the processing key for the conversation that
    // actually completed would never clear.
    const ctx = makeCtx({
      streamContext: null,
    });
    handleMessageComplete(
      {
        type: "message_complete",
        messageId: "msg-1",
        conversationId: "conv-from-event",
      },
      ctx,
    );
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-from-event",
      reason: "complete",
    });
  });

  it("re-anchors a spawned subagent from the streaming id to the server messageId", () => {
    useSubagentStore.getState().reset();
    // Spawn stamped with the optimistic streaming bubble id.
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Researcher",
      objective: "Investigate",
      timestamp: 1,
      parentMessageStableId: "stream-bubble-1",
    });
    expect(
      useSubagentStore.getState().byParent.get("stream-bubble-1"),
    ).toHaveLength(1);

    const ctx = makeCtx({
      currentAssistantMessageIdRef: { current: "stream-bubble-1" },
    });
    handleMessageComplete(
      { type: "message_complete", messageId: "server-msg-1" },
      ctx,
    );

    // Entry is now reachable via the durable server messageId.
    const byServer = useSubagentStore.getState().byParent.get("server-msg-1");
    expect(byServer).toHaveLength(1);
    expect(byServer?.[0]?.subagentId).toBe("sa-1");
    expect(useSubagentStore.getState().byId["sa-1"]?.parentMessageId).toBe(
      "server-msg-1",
    );
  });

  it("does not re-anchor when the event has no messageId", () => {
    useSubagentStore.getState().reset();
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Researcher",
      objective: "Investigate",
      timestamp: 1,
      parentMessageStableId: "stream-bubble-1",
    });

    const ctx = makeCtx({
      currentAssistantMessageIdRef: { current: "stream-bubble-1" },
    });
    handleMessageComplete({ type: "message_complete" }, ctx);

    expect(useSubagentStore.getState().byId["sa-1"]?.parentMessageId).toBe(
      undefined,
    );
  });

  it("does not re-anchor when there is no current assistant message id", () => {
    useSubagentStore.getState().reset();
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-1",
      label: "Researcher",
      objective: "Investigate",
      timestamp: 1,
      parentMessageStableId: "stream-bubble-1",
    });

    const ctx = makeCtx({
      currentAssistantMessageIdRef: { current: undefined },
    });
    handleMessageComplete(
      { type: "message_complete", messageId: "server-msg-1" },
      ctx,
    );

    expect(
      useSubagentStore.getState().byParent.get("server-msg-1"),
    ).toBeUndefined();
    expect(useSubagentStore.getState().byId["sa-1"]?.parentMessageId).toBe(
      undefined,
    );
  });
});

describe("handleUserMessageEcho", () => {
  const seededSnapshot: PaginatedHistoryResult = {
    messages: [],
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    seq: 1,
  };

  // The handler reads the real chat-session store to decide whether the paired
  // snapshot fold has somewhere to land. Reset it around each case so state
  // never leaks between tests.
  beforeEach(() => {
    useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  });
  afterEach(() => {
    useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  });

  /** Seed the snapshot, run the handler, and apply the captured
   *  setOptimisticSends updater. */
  function applyEcho(
    event: Parameters<typeof handleUserMessageEcho>[0],
    prev: DisplayMessage[],
  ): DisplayMessage[] {
    useChatSessionStore.setState({ snapshot: seededSnapshot });
    const ctx = makeCtx();
    handleUserMessageEcho(event, ctx);
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
    const updater = (ctx.setOptimisticSends as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];
    return updater(prev);
  }

  it("does NOT retire the optimistic send when the snapshot is unseeded (first-message flicker guard)", () => {
    // Regression: the first message of a freshly server-minted conversation has
    // no history snapshot yet, so `applyEnvelopeToSnapshot` no-ops. Retiring the
    // overlay here would blank the message out until `seedSnapshot` lands. The
    // reseed's `pruneConfirmedOptimisticSends` retires it instead.
    expect(useChatSessionStore.getState().snapshot).toBeNull();
    const ctx = makeCtx();
    handleUserMessageEcho(
      {
        type: "user_message_echo",
        text: "Hello",
        messageId: "msg-1",
        clientMessageId: "client-1",
      },
      ctx,
    );
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });

  it("removes the attachment-less optimistic send correlated by clientMessageId", () => {
    const next = applyEcho(
      {
        type: "user_message_echo",
        text: "Hello",
        messageId: "msg-1",
        clientMessageId: "client-1",
      },
      [
        {
          id: "client-1",
          clientMessageId: "client-1",
          role: "user",
          isOptimistic: true,
        } as DisplayMessage,
        {
          id: "client-2",
          clientMessageId: "client-2",
          role: "user",
          isOptimistic: true,
        } as DisplayMessage,
      ],
    );
    expect(next.map((m) => m.id)).toEqual(["client-2"]);
  });

  it("keeps an attachment-carrying send, upgraded to the server id", () => {
    // The echo event has no attachment payload, so the snapshot row it folds
    // is text-only — the optimistic row holds the only copy of the previews
    // and must survive until the reseed carries the hydrated server row.
    const next = applyEcho(
      {
        type: "user_message_echo",
        text: "look at this",
        messageId: "msg-1",
        clientMessageId: "client-1",
      },
      [
        {
          id: "client-1",
          clientMessageId: "client-1",
          role: "user",
          isOptimistic: true,
          queueStatus: "queued",
          queuePosition: 1,
          attachments: [
            {
              id: "att-1",
              filename: "shot.png",
              mimeType: "image/png",
              sizeBytes: 10,
              previewUrl: "blob:preview",
            },
          ],
        } as DisplayMessage,
      ],
    );
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "msg-1",
      clientMessageId: "client-1",
      isOptimistic: false,
    });
    expect(next[0]!.queueStatus).toBeUndefined();
    expect(next[0]!.queuePosition).toBeUndefined();
    expect(next[0]!.attachments?.[0]?.previewUrl).toBe("blob:preview");
  });

  it("removes an attachment-carrying send on a synthetic echo with no messageId", () => {
    // With no server id there is no snapshot row to collapse onto, so keeping
    // the row would double-render once the reducer appends its own copy.
    const next = applyEcho(
      {
        type: "user_message_echo",
        text: "look at this",
        clientMessageId: "client-1",
      },
      [
        {
          id: "client-1",
          clientMessageId: "client-1",
          role: "user",
          isOptimistic: true,
          attachments: [
            {
              id: "att-1",
              filename: "shot.png",
              mimeType: "image/png",
              sizeBytes: 10,
              previewUrl: "blob:preview",
            },
          ],
        } as DisplayMessage,
      ],
    );
    expect(next).toEqual([]);
  });

  it("leaves the list unchanged when no optimistic send matches the nonce", () => {
    const prev = [
      { id: "other", clientMessageId: "other", role: "user" } as DisplayMessage,
    ];
    const next = applyEcho(
      {
        type: "user_message_echo",
        text: "Hello",
        messageId: "msg-1",
        clientMessageId: "client-1",
      },
      prev,
    );
    expect(next).toBe(prev);
  });

  it("retires the most recent optimistic user send when the echo carries no nonce", () => {
    // No nonce to correlate on — the updater drops the last optimistic user
    // row, leaving others intact.
    const next = applyEcho(
      { type: "user_message_echo", text: "Hello", messageId: "msg-1" },
      [
        { id: "keep", role: "assistant" } as DisplayMessage,
        { id: "opt-1", role: "user", isOptimistic: true } as DisplayMessage,
      ],
    );
    expect(next.map((m) => m.id)).toEqual(["keep"]);
  });
});

describe("handleGenerationHandoff", () => {
  it("cancels reconciliation and hands off generation", () => {
    const ctx = makeCtx();
    handleGenerationHandoff(
      { type: "generation_handoff", messageId: "msg-1", queuedCount: 0 },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.turnActions.handoffGeneration).toHaveBeenCalled();
  });
});

describe("handleGenerationCancelled", () => {
  it("ends the turn with reason=cancelled", () => {
    const ctx = makeCtx();
    handleGenerationCancelled({ type: "generation_cancelled" }, ctx);
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "cancelled",
    });
  });

  it("prefers event.conversationId over streamContext when both differ", () => {
    const ctx = makeCtx({
      streamContext: null,
    });
    handleGenerationCancelled(
      { type: "generation_cancelled", conversationId: "conv-from-event" },
      ctx,
    );
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-from-event",
      reason: "cancelled",
    });
  });
});
