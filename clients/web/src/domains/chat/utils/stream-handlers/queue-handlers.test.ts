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

  it("counts the enqueue but binds no row when no pending messageId", () => {
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
    // The counter tracks the conversation's whole queue, so a send this client
    // did not originate still counts here and is decremented by the matching
    // dequeue or cancel broadcast.
    expect(ctx.turnActions.enqueueMessage).toHaveBeenCalledTimes(1);
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
    // Row binding is refused, but the foreign send is still part of the
    // conversation's queue, so the counter tracks it.
    expect(ctx.turnActions.enqueueMessage).toHaveBeenCalledTimes(1);
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

  it("spends the queue slot even when no messageId mapping exists", () => {
    // `handleMessageQueued` counted this entry's ack whether or not it bound
    // to a local row, so the decrement has to be symmetric. Only the
    // optimistic-row update is gated on the mapping.
    const ctx = makeCtx();
    handleMessageDequeued(
      {
        type: "message_dequeued",
        conversationId: "conv-1",
        requestId: "unknown",
      },
      ctx,
    );
    expect(ctx.turnActions.dequeueMessage).toHaveBeenCalledTimes(1);
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

  it("clears a snapshot-seeded queued row and still spends the queue slot", () => {
    // A row rendered from a `/messages` reseed is keyed by requestId and has
    // no requestId mapping, so removal falls back to the event's own key. The
    // decrement stays unconditional either way.
    useChatSessionStore.setState({
      snapshot: {
        messages: [
          {
            id: "req-seeded",
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
    const ctx = makeCtx();

    handleMessageDequeued(
      {
        type: "message_dequeued",
        conversationId: "conv-1",
        requestId: "req-seeded",
      },
      ctx,
    );

    expect(ctx.turnActions.dequeueMessage).toHaveBeenCalledTimes(1);
    expect(
      useChatSessionStore.getState().snapshot?.messages[0]?.queueStatus,
    ).toBeUndefined();
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
  it("spends the queue slot and removes the row when a mapping exists", () => {
    // A tab that never issued the cancel still holds the mapping when the
    // broadcast lands, so it owes both the decrement and the row removal.
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
    expect(ctx.turnActions.deleteQueuedMessage).toHaveBeenCalledTimes(1);
    expect(ctx.popRequestIdMapping).toHaveBeenCalledWith("req-1");
    expect(ctx.setOptimisticSends).toHaveBeenCalled();
  });

  it("still decrements on the cancelling tab, whose DELETE already popped the mapping", () => {
    // The cancelling tab's `onDeleted` only cleans up the mapping; it must not
    // decrement, because this broadcast echoes back to it and carries the one
    // decrement the cancel is owed. Losing that decrement would strand the
    // queued indicator after the last queued message was cancelled.
    const ctx = makeCtx({
      requestIdToMessageId: new Map([["req-1", "stable-1"]]),
    });
    expect(ctx.popRequestIdMapping("req-1")).toBe("stable-1");

    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctx,
    );
    expect(ctx.turnActions.deleteQueuedMessage).toHaveBeenCalledTimes(1);
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });

  it("spends the queue slot for a cancel with no local mapping", () => {
    // The daemon broadcasts to every subscriber, and every subscriber counted
    // the matching `message_queued`, so the decrement is symmetric even where
    // no local row was ever bound.
    const ctx = makeCtx();
    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "unknown",
      },
      ctx,
    );
    expect(ctx.turnActions.deleteQueuedMessage).toHaveBeenCalledTimes(1);
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
