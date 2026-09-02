/**
 * Tests for `useMaterializedDraftReconcile`.
 *
 * Drives the real `useConversationStore`, so what is asserted is the state a
 * consumer reads (`draftConversationIds`) rather than a call count.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { useMaterializedDraftReconcile } from "@/domains/chat/hooks/use-materialized-draft-reconcile";
import { useConversationStore } from "@/stores/conversation-store";
import type { Conversation } from "@/types/conversation-types";

afterEach(() => {
  cleanup();
  useConversationStore.getState().reset();
});

const list = (...conversationIds: string[]): Conversation[] =>
  conversationIds.map((conversationId) => ({ conversationId }));

const isDraft = (conversationId: string): boolean =>
  useConversationStore.getState().draftConversationIds.has(conversationId);

describe("useMaterializedDraftReconcile", () => {
  test("a refetched list carrying the draft's id clears the mark", () => {
    useConversationStore.getState().registerDraftConversationId("conv-draft");
    const { rerender } = renderHook(
      (conversations: Conversation[]) =>
        useMaterializedDraftReconcile(conversations),
      { initialProps: list("conv-old") },
    );
    expect(isDraft("conv-draft")).toBe(true);

    // What a create invalidation produces: the same query, a new array, the
    // new row in it.
    rerender(list("conv-draft", "conv-old"));

    expect(isDraft("conv-draft")).toBe(false);
  });

  test("a list without the id leaves the mark, however often it refetches", () => {
    useConversationStore.getState().registerDraftConversationId("conv-draft");
    const { rerender } = renderHook(
      (conversations: Conversation[]) =>
        useMaterializedDraftReconcile(conversations),
      { initialProps: list("conv-old") },
    );

    rerender(list("conv-old", "conv-other"));

    expect(isDraft("conv-draft")).toBe(true);
  });

  test("only the ids the list carries lose their mark", () => {
    useConversationStore.getState().registerDraftConversationId("conv-draft");
    useConversationStore.getState().registerDraftConversationId("conv-other");
    const { rerender } = renderHook(
      (conversations: Conversation[]) =>
        useMaterializedDraftReconcile(conversations),
      { initialProps: list() },
    );

    rerender(list("conv-draft"));

    expect(isDraft("conv-draft")).toBe(false);
    expect(isDraft("conv-other")).toBe(true);
  });
});
