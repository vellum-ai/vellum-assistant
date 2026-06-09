import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleAssistantTextDelta,
  handleAssistantThinkingDelta,
  handleAssistantTurnStart,
  handleAssistantActivityState,
  handleMessageComplete,
  handleGenerationHandoff,
  handleGenerationCancelled,
} from "@/domains/chat/utils/stream-handlers/message-handlers";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { textBody } from "@/domains/chat/utils/message-test-helpers";
import { conversationsQueryKey } from "@/lib/sync/query-tags";
import { findConversation } from "@/utils/conversation-cache";
import type { Conversation } from "@/types/conversation-types";

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
    expect(ctx.setMessages).toHaveBeenCalled();
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

  it("creates a new bubble when there is no assistant tail to fold into", () => {
    // Empty messages → no assistant tail, so the delta opens a new bubble.
    const ctx = makeCtx();
    handleAssistantTextDelta({ type: "assistant_text_delta", text: "Hi" }, ctx);
    expect(ctx.setMessages).toHaveBeenCalled();
    // Apply the updater to an empty array to confirm a new bubble emerges.
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (prev: never[]) => unknown[];
    const next = updater([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      role: "assistant",
      ...textBody("Hi"),
    });
  });
});

describe("handleAssistantThinkingDelta", () => {
  it("cancels reconciliation and accumulates reasoning onto the streaming row", () => {
    // GIVEN a fresh stream context (no assistant tail yet — the reasoning
    // burst precedes any text, as with reasoning-heavy models)
    const ctx = makeCtx();

    // WHEN a thinking delta arrives
    handleAssistantThinkingDelta(
      { type: "assistant_thinking_delta", thinking: "reasoning" },
      ctx,
    );

    // THEN a pending reconcile is cancelled and the row updater runs
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();

    // AND applying the updater opens an assistant bubble carrying the
    // reasoning as a thinking block, stamping the current-assistant ref
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (prev: never[]) => unknown[];
    const next = updater([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      role: "assistant",
      thinkingSegments: ["reasoning"],
      contentOrder: [{ type: "thinking", id: "0" }],
    });
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
    expect(ctx.setMessages).toHaveBeenCalled();
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
    expect(ctx.turnActions.onActivityThinking).toHaveBeenCalledWith(undefined);
    expect(ctx.setMessages).not.toHaveBeenCalled();
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
    );
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
    expect(ctx.setMessages).toHaveBeenCalled();
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
