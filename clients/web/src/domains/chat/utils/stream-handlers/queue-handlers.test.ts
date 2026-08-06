import { afterEach, describe, expect, it } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
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

  it("returns early without counting the enqueue when no pending messageId", () => {
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
    // No local row owns the ack, so the turn store must not report a pending
    // queued send the drawer can never show.
    expect(ctx.turnActions.enqueueMessage).not.toHaveBeenCalled();
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
    expect(ctx.turnActions.enqueueMessage).not.toHaveBeenCalled();
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

  it("does not spend a queue slot for a dequeue this client never counted", () => {
    // Only `handleMessageQueued` increments the counter, and only when it
    // could bind the ack to a local row, in which case it also writes the
    // requestId mapping. An unpaired dequeue (another tab's send, a
    // daemon-internal enqueue) has no mapping and must leave the count alone.
    const ctx = makeCtx();
    handleMessageDequeued(
      {
        type: "message_dequeued",
        conversationId: "conv-1",
        requestId: "unknown",
      },
      ctx,
    );
    expect(ctx.turnActions.dequeueMessage).not.toHaveBeenCalled();
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

  it("clears a snapshot-seeded queued row without touching the counter", () => {
    // A row rendered from a `/messages` reseed is keyed by requestId and never
    // ran through `handleMessageQueued`, so it owns no queue slot, but it is
    // on screen and must stop reading as queued.
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

    expect(ctx.turnActions.dequeueMessage).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().snapshot?.messages[0]?.queueStatus,
    ).toBeUndefined();
  });
});

describe("handleMessageQueuedDeleted", () => {
  it("spends the queue slot on a tab that counted the enqueue but did not cancel", () => {
    // A second tab watching the same conversation counted the enqueue, so its
    // mapping is still present when the broadcast lands. That tab owes the
    // decrement and the row removal.
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

  it("does not decrement twice on the tab that issued the cancel", () => {
    // The cancelling tab pops the mapping in its own `onDeleted`, so the
    // broadcast echo finds nothing to pair with. A second decrement would
    // retire the turn at count 0 while a real message is still queued.
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
    expect(ctx.turnActions.deleteQueuedMessage).not.toHaveBeenCalled();
    expect(ctx.setOptimisticSends).not.toHaveBeenCalled();
  });

  it("does not spend a queue slot for a cancel this client never counted", () => {
    // The daemon broadcasts to every subscriber, so a tab that never saw the
    // enqueue (opened mid-turn, or another tab's send) receives this too and
    // must leave its own count alone.
    const ctx = makeCtx();
    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "unknown",
      },
      ctx,
    );
    expect(ctx.turnActions.deleteQueuedMessage).not.toHaveBeenCalled();
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
