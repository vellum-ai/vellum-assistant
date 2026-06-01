import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleMessageQueued,
  handleMessageDequeued,
  handleMessageQueuedDeleted,
  handleMessageRequestComplete,
} from "@/domains/chat/utils/stream-handlers/queue-handlers";

describe("handleMessageQueued", () => {
  it("maps requestId to messageId and sets queue position", () => {
    const ctx = makeCtx({
      pendingQueuedMessageIdsRef: { current: ["stable-1"] },
    });
    handleMessageQueued(
      {
        type: "message_queued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 2,
      },
      ctx,
    );
    expect(ctx.turnActions.enqueueMessage).toHaveBeenCalled();
    expect(ctx.requestIdToMessageIdRef.current.get("req-1")).toBe("stable-1");
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("returns early when no pending messageId", () => {
    const ctx = makeCtx({
      pendingQueuedMessageIdsRef: { current: [] },
    });
    handleMessageQueued(
      {
        type: "message_queued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 0,
      },
      ctx,
    );
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });

  it("deletes queued message when messageId is in pending deletions", () => {
    const ctx = makeCtx({
      pendingQueuedMessageIdsRef: { current: ["stable-1"] },
      pendingLocalDeletionsRef: { current: new Set(["stable-1"]) },
    });
    handleMessageQueued(
      {
        type: "message_queued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 0,
      },
      ctx,
    );
    expect(ctx.pendingLocalDeletionsRef.current.has("stable-1")).toBe(false);
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});

describe("handleMessageDequeued", () => {
  it("clears queue status when messageId mapping exists", () => {
    const ctx = makeCtx();
    ctx.requestIdToMessageIdRef.current.set("req-1", "stable-1");
    handleMessageDequeued(
      {
        type: "message_dequeued",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctx,
    );
    expect(ctx.turnActions.dequeueMessage).toHaveBeenCalled();
    expect(ctx.requestIdToMessageIdRef.current.has("req-1")).toBe(false);
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("skips setMessages when no messageId mapping exists", () => {
    const ctx = makeCtx();
    handleMessageDequeued(
      {
        type: "message_dequeued",
        conversationId: "conv-1",
        requestId: "unknown",
      },
      ctx,
    );
    expect(ctx.turnActions.dequeueMessage).toHaveBeenCalled();
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});

describe("handleMessageQueuedDeleted", () => {
  it("removes queued message when messageId mapping exists", () => {
    const ctx = makeCtx();
    ctx.requestIdToMessageIdRef.current.set("req-1", "stable-1");
    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctx,
    );
    expect(ctx.turnActions.deleteQueuedMessage).toHaveBeenCalled();
    expect(ctx.requestIdToMessageIdRef.current.has("req-1")).toBe(false);
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("skips setMessages when no messageId mapping exists", () => {
    const ctx = makeCtx();
    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "unknown",
      },
      ctx,
    );
    expect(ctx.turnActions.deleteQueuedMessage).toHaveBeenCalled();
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});

describe("handleMessageRequestComplete", () => {
  it("is an intentional no-op", () => {
    const ctx = makeCtx();
    handleMessageRequestComplete(
      {
        type: "message_request_complete",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctx,
    );
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});
