import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "@/types/conversation-types";
import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";

// The Background/Scheduled sections own their lazy queries; stub both so the
// hook resolves without a QueryClient and these tests stay focused on the
// foreground grouping/pagination they exercise.
mock.module("@/hooks/conversation-queries", () => ({
  useBackgroundConversationListQuery: () => ({
    conversations: [],
    isPending: false,
  }),
  useScheduledConversationListQuery: () => ({
    conversations: [],
    isPending: false,
  }),
}));

const { SIDEBAR_CONVERSATION_LIMIT, useSidebarState } = await import(
  "@/domains/chat/use-sidebar-state"
);

function makeConversation(
  index: number,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    conversationId: `conversation-${index}`,
    title: `Thread ${index}`,
    groupId: "system:all",
    hasUnseenLatestAssistantMessage: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  useSidebarCollapseStore.setState({
    assistantId: null,
    openCategories: [],
    openCustomGroups: [],
  });
});

describe("useSidebarState pagination", () => {
  test("reveals recents in page-size increments and can reset", () => {
    const conversations = Array.from({ length: 12 }, (_, index) =>
      makeConversation(index),
    );

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
      }),
    );

    expect(result.current.recents.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT,
    );
    expect(result.current.recents.showMore).toBe(true);
    expect(result.current.recents.showLess).toBe(false);

    act(() => result.current.recents.onShowMore());

    expect(result.current.recents.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT * 2,
    );
    expect(result.current.recents.showMore).toBe(true);
    expect(result.current.recents.showLess).toBe(true);

    act(() => result.current.recents.onShowMore());

    expect(result.current.recents.items).toHaveLength(conversations.length);
    expect(result.current.recents.showMore).toBe(false);
    expect(result.current.recents.showLess).toBe(true);

    act(() => result.current.recents.onShowLess());

    expect(result.current.recents.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT,
    );
    expect(result.current.recents.showMore).toBe(true);
    expect(result.current.recents.showLess).toBe(false);
  });

  test("uses the same incremental reveal behavior for Slack conversations", () => {
    const conversations = Array.from({ length: 12 }, (_, index) =>
      makeConversation(index, {
        originChannel: "slack",
      }),
    );

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
      }),
    );

    expect(result.current.slack.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT,
    );
    expect(result.current.slack.showMore).toBe(true);
    expect(result.current.slack.showLess).toBe(false);

    act(() => result.current.slack.onShowMore());

    expect(result.current.slack.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT * 2,
    );
    expect(result.current.slack.showMore).toBe(true);
    expect(result.current.slack.showLess).toBe(true);
  });
});
