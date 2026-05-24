import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers.js";
import {
  handleAssistantTextDelta,
  handleAssistantActivityState,
  handleMessageComplete,
  handleGenerationHandoff,
  handleGenerationCancelled,
} from "@/domains/chat/utils/stream-handlers/message-handlers.js";

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

  it("creates a new bubble when needsNewBubbleRef is true", () => {
    const ctx = makeCtx({ needsNewBubbleRef: { current: true } });
    handleAssistantTextDelta(
      { type: "assistant_text_delta", text: "Hi" },
      ctx,
    );
    expect(ctx.needsNewBubbleRef.current).toBe(false);
    expect(ctx.setMessages).toHaveBeenCalled();
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
      1,
      ctx,
    );
    expect(ctx.turnActions.onActivityThinking).not.toHaveBeenCalled();
    expect(ctx.turnActions.completeTurn).not.toHaveBeenCalled();
  });

  it("updates version and handles idle phase", () => {
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
      1,
      ctx,
    );
    expect(ctx.lastActivityVersionRef.current.get("conv-1")).toBe(1);
    expect(ctx.setMessages).toHaveBeenCalled();
    expect(ctx.needsNewBubbleRef.current).toBe(true);
    expect(ctx.turnActions.completeTurn).toHaveBeenCalled();
    expect(ctx.clearProcessingKey).toHaveBeenCalledWith("conv-1");
    expect(ctx.startReconciliationLoop).toHaveBeenCalledWith(1);
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
      1,
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
      1,
      ctx,
    );
    expect(ctx.turnActions.onActivityThinking).toHaveBeenCalledWith("Processing bash results");
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
      },
      1,
      ctx,
    );
    expect(ctx.lastActivityVersionRef.current.get(
      ctx.streamContextRef.current!.conversationId,
    )).toBe(1);
    expect(ctx.turnActions.onActivityThinking).not.toHaveBeenCalled();
    expect(ctx.turnActions.completeTurn).not.toHaveBeenCalled();
  });
});

describe("handleMessageComplete", () => {
  it("finalizes message and starts reconciliation", () => {
    const ctx = makeCtx();
    handleMessageComplete(
      { type: "message_complete", messageId: "msg-1", content: "Done" },
      1,
      ctx,
    );
    expect(ctx.setMessages).toHaveBeenCalled();
    expect(ctx.needsNewBubbleRef.current).toBe(true);
    expect(ctx.turnActions.completeTurn).toHaveBeenCalled();
    expect(ctx.clearProcessingKey).toHaveBeenCalledWith("conv-1");
    expect(ctx.startReconciliationLoop).toHaveBeenCalledWith(1);
  });
});

describe("handleGenerationHandoff", () => {
  it("cancels reconciliation and sets needsNewBubble", () => {
    const ctx = makeCtx();
    handleGenerationHandoff(
      { type: "generation_handoff", messageId: "msg-1" },
      ctx,
    );
    expect(ctx.cancelReconciliation).toHaveBeenCalled();
    expect(ctx.turnActions.handoffGeneration).toHaveBeenCalled();
    expect(ctx.needsNewBubbleRef.current).toBe(true);
  });
});

describe("handleGenerationCancelled", () => {
  it("dispatches GENERATION_CANCELLED and clears processing", () => {
    const ctx = makeCtx();
    handleGenerationCancelled({ type: "generation_cancelled" }, ctx);
    expect(ctx.turnActions.cancelGeneration).toHaveBeenCalled();
    expect(ctx.clearProcessingKey).toHaveBeenCalledWith("conv-1");
    expect(ctx.setMessages).toHaveBeenCalled();
    expect(ctx.needsNewBubbleRef.current).toBe(true);
  });
});
