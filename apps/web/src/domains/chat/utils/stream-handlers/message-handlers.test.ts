import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleAssistantTextDelta,
  handleAssistantTurnStart,
  handleAssistantActivityState,
  handleMessageComplete,
  handleGenerationHandoff,
  handleGenerationCancelled,
} from "@/domains/chat/utils/stream-handlers/message-handlers";
import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { useSubagentStore } from "@/domains/chat/subagent-store";

describe("handleAssistantTurnStart", () => {
  it("seeds currentAssistantMessageIdRef from the event's messageId", () => {
    const ctx = makeCtx();
    handleAssistantTurnStart(
      { type: "assistant_turn_start", messageId: "msg-A" },
      ctx,
    );
    expect(ctx.currentAssistantMessageIdRef.current).toBe("msg-A");
  });

  it("flips an existing reconcile-pulled row to isStreaming", () => {
    // Screenshot scenario: reconcile poll pulled in the daemon's reserved
    // row (empty content, no `isStreaming` flag) before SSE delivered
    // `assistant_turn_start`. The handler must flip it to streaming so
    // the subsequent delta doesn't open a duplicate bubble.
    const ctx = makeCtx();
    handleAssistantTurnStart(
      { type: "assistant_turn_start", messageId: "msg-X" },
      ctx,
    );
    expect(ctx.setMessages).toHaveBeenCalled();
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];

    const prev: DisplayMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "hi",
        timestamp: 1,
      } as DisplayMessage,
      {
        id: "msg-X",
        role: "assistant",
        content: "",
        textSegments: [],
        contentOrder: [],
        timestamp: 2,
      } as DisplayMessage,
    ];
    const next = updater(prev);
    expect(next).toHaveLength(2);
    expect(next[1]!.isStreaming).toBe(true);
    expect(next[1]!.id).toBe("msg-X");
  });

  it("is a no-op on messages when no row matches the messageId", () => {
    // Common case: SSE strictly precedes reconcile, so the reserved row
    // hasn't been pulled in yet. The handler stamps the ref but leaves
    // the array referentially identical.
    const ctx = makeCtx();
    handleAssistantTurnStart(
      { type: "assistant_turn_start", messageId: "msg-Y" },
      ctx,
    );
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];

    const prev: DisplayMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "hi",
        timestamp: 1,
      } as DisplayMessage,
    ];
    const next = updater(prev);
    expect(next).toBe(prev);
  });

  it("does not re-touch a row that is already streaming", () => {
    const ctx = makeCtx();
    handleAssistantTurnStart(
      { type: "assistant_turn_start", messageId: "msg-Z" },
      ctx,
    );
    const updater = (ctx.setMessages as unknown as ReturnType<typeof Object>)
      .mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];

    const prev: DisplayMessage[] = [
      {
        id: "msg-Z",
        role: "assistant",
        content: "Hello",
        isStreaming: true,
        textSegments: [{ type: "text", content: "Hello" }],
        contentOrder: [{ type: "text", id: "0" }],
        timestamp: 1,
      } as DisplayMessage,
    ];
    const next = updater(prev);
    expect(next).toBe(prev);
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

  it("creates a new bubble when the tail is not a streaming assistant", () => {
    // Empty messages → tail derivation says "create new bubble".
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
      isStreaming: true,
      content: "Hi",
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
        ctx.streamContextRef.current!.conversationId,
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

  it("prefers event.conversationId over streamContextRef when both differ", () => {
    // streamContextRef is a mirror that may be cleared by a stream
    // teardown that races the terminal event. When the event itself
    // carries the canonical conversationId, the handler must use it
    // — otherwise the processing key for the conversation that
    // actually completed would never clear.
    const ctx = makeCtx({
      streamContextRef: { current: null },
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
  it("cancels reconciliation and finalizes streaming tail", () => {
    const ctx = makeCtx();
    handleGenerationHandoff(
      { type: "generation_handoff", messageId: "msg-1", queuedCount: 0 },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.turnActions.handoffGeneration).toHaveBeenCalled();
    expect(ctx.setMessages).toHaveBeenCalled();
  });
});

describe("handleGenerationCancelled", () => {
  it("ends the turn with reason=cancelled and stops streaming rows", () => {
    const ctx = makeCtx();
    handleGenerationCancelled({ type: "generation_cancelled" }, ctx);
    expect(ctx.endTurn).toHaveBeenCalledWith({
      conversationId: "conv-1",
      reason: "cancelled",
    });
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("prefers event.conversationId over streamContextRef when both differ", () => {
    const ctx = makeCtx({
      streamContextRef: { current: null },
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
