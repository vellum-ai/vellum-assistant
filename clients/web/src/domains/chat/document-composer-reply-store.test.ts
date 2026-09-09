/**
 * Tests for `document-composer-reply-store`, the set of conversation ids the
 * document composer is waiting on an assistant reply for.
 *
 * `useDocumentComposerSubmit` writes to it after a send and
 * `DocumentComposerReplyWatcher` reads and clears it, so the two sides only
 * agree if membership is exact: this file pins the set semantics directly
 * through the store's non-React API.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";

function getState() {
  return useDocumentComposerReplyStore.getState();
}

function watchedIds(): string[] {
  return [...getState().awaitingReplyConversationIds];
}

function queuedIds(): string[] {
  return [...getState().queuedReplyConversationIds];
}

beforeEach(() => {
  useDocumentComposerReplyStore.setState({
    awaitingReplyConversationIds: new Set(),
    queuedReplyConversationIds: new Set(),
  });
});

describe("startAwaitingReply", () => {
  test("records a conversation as awaiting a reply", () => {
    getState().startAwaitingReply("conv-1");
    expect(getState().awaitingReplyConversationIds.has("conv-1")).toBe(true);
  });

  test("recording the same conversation twice tracks it once", () => {
    getState().startAwaitingReply("conv-1");
    getState().startAwaitingReply("conv-1");
    expect(watchedIds()).toEqual(["conv-1"]);
  });

  test("tracks two conversations independently", () => {
    getState().startAwaitingReply("conv-1");
    getState().startAwaitingReply("conv-2");
    expect(getState().awaitingReplyConversationIds.has("conv-1")).toBe(true);
    expect(getState().awaitingReplyConversationIds.has("conv-2")).toBe(true);

    getState().stopAwaitingReply("conv-1");
    expect(getState().awaitingReplyConversationIds.has("conv-1")).toBe(false);
    expect(getState().awaitingReplyConversationIds.has("conv-2")).toBe(true);
  });
});

describe("markReplyQueued", () => {
  test("starts the wait and flags it as queued", () => {
    getState().markReplyQueued("conv-1");
    expect(watchedIds()).toEqual(["conv-1"]);
    expect(queuedIds()).toEqual(["conv-1"]);
  });

  test("flags a wait that is already up", () => {
    getState().startAwaitingReply("conv-1");
    getState().markReplyQueued("conv-1");
    expect(watchedIds()).toEqual(["conv-1"]);
    expect(queuedIds()).toEqual(["conv-1"]);
  });
});

describe("clearReplyQueued", () => {
  test("unflags the wait without ending it", () => {
    getState().markReplyQueued("conv-1");

    getState().clearReplyQueued("conv-1");

    expect(queuedIds()).toEqual([]);
    expect(watchedIds()).toEqual(["conv-1"]);
  });

  test("is a no-op for a wait that was never flagged", () => {
    getState().startAwaitingReply("conv-1");
    const before = getState().queuedReplyConversationIds;

    getState().clearReplyQueued("conv-1");

    expect(getState().queuedReplyConversationIds).toBe(before);
    expect(watchedIds()).toEqual(["conv-1"]);
  });
});

describe("stopAwaitingReply", () => {
  test("stops tracking a conversation once its reply lands", () => {
    getState().startAwaitingReply("conv-1");
    getState().stopAwaitingReply("conv-1");
    expect(getState().awaitingReplyConversationIds.has("conv-1")).toBe(false);
    expect(watchedIds()).toEqual([]);
  });

  test("clears the queued flag along with the wait", () => {
    getState().markReplyQueued("conv-1");

    getState().stopAwaitingReply("conv-1");

    expect(watchedIds()).toEqual([]);
    expect(queuedIds()).toEqual([]);
  });

  test("is a no-op for a conversation that was never awaiting a reply", () => {
    getState().startAwaitingReply("conv-1");
    const before = getState().awaitingReplyConversationIds;

    getState().stopAwaitingReply("conv-never-sent");

    expect(getState().awaitingReplyConversationIds).toBe(before);
    expect(watchedIds()).toEqual(["conv-1"]);
  });
});

describe("clearAwaitingReplies", () => {
  test("drops every wait at once", () => {
    getState().startAwaitingReply("conv-1");
    getState().startAwaitingReply("conv-2");

    getState().clearAwaitingReplies();

    expect(watchedIds()).toEqual([]);
  });

  test("drops the queued flags too", () => {
    getState().markReplyQueued("conv-1");
    getState().markReplyQueued("conv-2");

    getState().clearAwaitingReplies();

    expect(watchedIds()).toEqual([]);
    expect(queuedIds()).toEqual([]);
  });

  test("is a no-op when nothing is awaiting a reply", () => {
    const before = getState().awaitingReplyConversationIds;

    getState().clearAwaitingReplies();

    expect(getState().awaitingReplyConversationIds).toBe(before);
  });
});
