import { afterEach, describe, expect, it } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleMessageQueued,
  handleMessageDequeued,
  handleMessageQueuedDeleted,
  handleMessageRequestComplete,
} from "@/domains/chat/utils/stream-handlers/queue-handlers";

afterEach(() => {
  useChatSessionStore.setState({ snapshot: null });
});

describe("handleMessageQueued", () => {
  it("maps requestId to messageId and sets queue position", () => {
    const ctx = makeCtx({
      pendingQueuedMessageIds: ["stable-1"],
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
    expect(ctx.shiftPendingQueuedMessageId).toHaveBeenCalled();
    expect(ctx.setRequestIdMapping).toHaveBeenCalledWith("req-1", "stable-1");
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
  });

  it("returns early when no pending messageId", () => {
    const ctx = makeCtx({
      pendingQueuedMessageIds: [],
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
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });

  it("deletes queued message when messageId is in pending deletions", () => {
    const ctx = makeCtx({
      pendingQueuedMessageIds: ["stable-1"],
      pendingLocalDeletions: new Set(["stable-1"]),
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
    expect(ctx.consumePendingLocalDeletion).toHaveBeenCalledWith("stable-1");
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });
});

describe("handleMessageDequeued", () => {
  it("clears queue status when messageId mapping exists", () => {
    const ctx = makeCtx({
      requestIdToMessageId: new Map([["req-1", "stable-1"]]),
    });
    handleMessageDequeued(
      {
        type: "message_dequeued",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctx,
    );
    expect(ctx.turnActions.dequeueMessage).toHaveBeenCalled();
    expect(ctx.popRequestIdMapping).toHaveBeenCalledWith("req-1");
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
  });

  it("skips setOptimisticSends when no messageId mapping exists", () => {
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
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });

  it("marks an uncorrelated transcript row optimistic until its echo", () => {
    useChatSessionStore.setState({
      snapshot: {
        messages: [
          {
            id: "req-1",
            role: "user",
            queueStatus: "queued",
            queuePosition: 1,
          },
        ],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      },
    });

    handleMessageDequeued(
      {
        type: "message_dequeued",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      makeCtx(),
    );

    const message = useChatSessionStore.getState().snapshot?.messages[0];
    expect(message?.isOptimistic).toBe(true);
    expect(message?.queueStatus).toBeUndefined();
    expect(message?.queuePosition).toBeUndefined();
  });
});

describe("handleMessageQueuedDeleted", () => {
  it("removes queued message when messageId mapping exists", () => {
    const ctx = makeCtx({
      requestIdToMessageId: new Map([["req-1", "stable-1"]]),
    });
    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctx,
    );
    expect(ctx.turnActions.deleteQueuedMessage).toHaveBeenCalled();
    expect(ctx.popRequestIdMapping).toHaveBeenCalledWith("req-1");
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
  });

  it("skips setOptimisticSends when no messageId mapping exists", () => {
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
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });

  it("removes a server-backed queued transcript row", () => {
    useChatSessionStore.setState({
      snapshot: {
        messages: [
          {
            id: "req-1",
            role: "user",
            queueStatus: "queued",
            queuePosition: 1,
          },
        ],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      },
    });

    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      makeCtx(),
    );

    expect(useChatSessionStore.getState().snapshot?.messages).toEqual([]);
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
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });
});
