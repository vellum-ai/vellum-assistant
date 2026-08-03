import { afterEach, describe, expect, it } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleMessageQueued,
  handleMessageDequeued,
  handleMessageQueuedDeleted,
  handleMessageRequeued,
  handleMessageRequestComplete,
} from "@/domains/chat/utils/stream-handlers/queue-handlers";

afterEach(() => {
  useChatSessionStore.setState({ snapshot: null });
});

describe("handleMessageQueued", () => {
  it("maps requestId to messageId and stores the wire position as-is", () => {
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

    // The event's position is 1-based on the wire; it must reach the row
    // unchanged so live acks agree with cold-load queued snapshots.
    const updater = (
      ctx.setOptimisticSends as unknown as ReturnType<typeof Object>
    ).mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];
    const updated = updater([
      { id: "stable-1", role: "user", queuePosition: 0 } as DisplayMessage,
    ]);
    expect(updated[0]?.queuePosition).toBe(2);
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

  it("binds by clientMessageId even when the nonce is not at the FIFO head", () => {
    const pending = ["other-send", "stable-1"];
    const ctx = makeCtx({
      pendingQueuedMessageIds: pending,
    });
    handleMessageQueued(
      {
        type: "message_queued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 2,
        clientMessageId: "stable-1",
      },
      ctx,
    );
    expect(ctx.setRequestIdMapping).toHaveBeenCalledWith("req-1", "stable-1");
    expect(ctx.shiftPendingQueuedMessageId).not.toHaveBeenCalled();
    // The unrelated pending entry keeps its place for its own ack.
    expect(pending).toEqual(["other-send"]);
  });

  it("ignores an ack whose clientMessageId this client is not tracking", () => {
    const pending = ["stable-1"];
    const ctx = makeCtx({
      pendingQueuedMessageIds: pending,
    });
    handleMessageQueued(
      {
        type: "message_queued",
        conversationId: "conv-1",
        requestId: "req-foreign",
        position: 3,
        clientMessageId: "someone-elses-send",
      },
      ctx,
    );
    expect(ctx.setRequestIdMapping).not.toHaveBeenCalled();
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
    // The local pending entry is untouched and still awaits its own ack.
    expect(pending).toEqual(["stable-1"]);
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

describe("handleMessageRequeued", () => {
  it("restores the pending row the dequeue cleared, keyed by the nonce", () => {
    const ctx = makeCtx();
    handleMessageRequeued(
      {
        type: "message_requeued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 1,
        clientMessageId: "nonce-1",
      },
      ctx,
    );

    expect(ctx.turnActions.enqueueMessage).toHaveBeenCalled();
    // The dequeue consumed the mapping, so it has to be re-registered or the
    // eventual second dequeue has nothing to clear.
    expect(ctx.setRequestIdMapping).toHaveBeenCalledWith("req-1", "nonce-1");

    const updater = (
      ctx.setOptimisticSends as unknown as ReturnType<typeof Object>
    ).mock.calls[0][0] as (prev: DisplayMessage[]) => DisplayMessage[];
    const updated = updater([
      {
        id: "stable-1",
        role: "user",
        clientMessageId: "nonce-1",
      } as DisplayMessage,
    ]);
    expect(updated[0]?.queueStatus).toBe("queued");
    expect(updated[0]?.queuePosition).toBe(1);
  });

  it("falls back to the requestId when the sender minted no nonce", () => {
    const ctx = makeCtx();
    handleMessageRequeued(
      {
        type: "message_requeued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 2,
      },
      ctx,
    );
    expect(ctx.setRequestIdMapping).toHaveBeenCalledWith("req-1", "req-1");
  });

  it("re-marks a server-backed queued transcript row", () => {
    useChatSessionStore.setState({
      snapshot: {
        messages: [{ id: "req-1", role: "user" }],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      },
    });

    handleMessageRequeued(
      {
        type: "message_requeued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 3,
      },
      makeCtx(),
    );

    const message = useChatSessionStore.getState().snapshot?.messages[0];
    expect(message?.queueStatus).toBe("queued");
    expect(message?.queuePosition).toBe(3);
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
