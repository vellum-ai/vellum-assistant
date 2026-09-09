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

beforeEach(() => {
  useDocumentComposerReplyStore.setState({
    awaitingReplyConversationIds: new Set(),
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

describe("stopAwaitingReply", () => {
  test("stops tracking a conversation once its reply lands", () => {
    getState().startAwaitingReply("conv-1");
    getState().stopAwaitingReply("conv-1");
    expect(getState().awaitingReplyConversationIds.has("conv-1")).toBe(false);
    expect(watchedIds()).toEqual([]);
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

  test("is a no-op when nothing is awaiting a reply", () => {
    const before = getState().awaitingReplyConversationIds;

    getState().clearAwaitingReplies();

    expect(getState().awaitingReplyConversationIds).toBe(before);
  });
});
