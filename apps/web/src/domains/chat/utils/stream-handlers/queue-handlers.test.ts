import { describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers.js";
import {
  handleMessageQueued,
  handleMessageDequeued,
  handleMessageQueuedDeleted,
  handleMessageRequestComplete,
} from "@/domains/chat/utils/stream-handlers/queue-handlers.js";

describe("handleMessageQueued", () => {
  it("maps requestId to stableId and sets queue position", () => {
    const ctx = makeCtx({
      pendingQueuedStableIdsRef: { current: ["stable-1"] },
    });
    handleMessageQueued(
      { type: "message_queued", requestId: "req-1", position: 2 },
      ctx,
    );
    expect(ctx.turnActions.enqueueMessage).toHaveBeenCalled();
    expect(ctx.requestIdToStableIdRef.current.get("req-1")).toBe("stable-1");
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("returns early when no pending stableId", () => {
    const ctx = makeCtx({
      pendingQueuedStableIdsRef: { current: [] },
    });
    handleMessageQueued(
      { type: "message_queued", requestId: "req-1", position: 0 },
      ctx,
    );
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });

  it("deletes queued message when stableId is in pending deletions", () => {
    const ctx = makeCtx({
      pendingQueuedStableIdsRef: { current: ["stable-1"] },
      pendingLocalDeletionsRef: { current: new Set(["stable-1"]) },
    });
    handleMessageQueued(
      { type: "message_queued", requestId: "req-1", position: 0 },
      ctx,
    );
    expect(ctx.pendingLocalDeletionsRef.current.has("stable-1")).toBe(false);
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});

describe("handleMessageDequeued", () => {
  it("clears queue status when stableId mapping exists", () => {
    const ctx = makeCtx();
    ctx.requestIdToStableIdRef.current.set("req-1", "stable-1");
    handleMessageDequeued(
      { type: "message_dequeued", requestId: "req-1" },
      ctx,
    );
    expect(ctx.turnActions.dequeueMessage).toHaveBeenCalled();
    expect(ctx.requestIdToStableIdRef.current.has("req-1")).toBe(false);
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("skips setMessages when no stableId mapping exists", () => {
    const ctx = makeCtx();
    handleMessageDequeued(
      { type: "message_dequeued", requestId: "unknown" },
      ctx,
    );
    expect(ctx.turnActions.dequeueMessage).toHaveBeenCalled();
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});

describe("handleMessageQueuedDeleted", () => {
  it("removes queued message when stableId mapping exists", () => {
    const ctx = makeCtx();
    ctx.requestIdToStableIdRef.current.set("req-1", "stable-1");
    handleMessageQueuedDeleted(
      { type: "message_queued_deleted", requestId: "req-1" },
      ctx,
    );
    expect(ctx.turnActions.deleteQueuedMessage).toHaveBeenCalled();
    expect(ctx.requestIdToStableIdRef.current.has("req-1")).toBe(false);
    expect(ctx.setMessages).toHaveBeenCalled();
  });

  it("skips setMessages when no stableId mapping exists", () => {
    const ctx = makeCtx();
    handleMessageQueuedDeleted(
      { type: "message_queued_deleted", requestId: "unknown" },
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
      { type: "message_request_complete", requestId: "req-1" },
      ctx,
    );
    expect(ctx.setMessages).not.toHaveBeenCalled();
  });
});
