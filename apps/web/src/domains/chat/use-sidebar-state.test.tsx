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
  test("toggles between collapsed (Show more) and expanded (Show less)", () => {
    const conversations = Array.from({ length: 12 }, (_, index) =>
      makeConversation(index),
    );

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
      }),
    );

    // Collapsed: shows default limit with "Show more"
    expect(result.current.recents.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT,
    );
    expect(result.current.recents.showMore).toBe(true);
    expect(result.current.recents.showLess).toBe(false);

    // Expand: shows all items with "Show less"
    act(() => result.current.recents.onShowMore());

    expect(result.current.recents.items).toHaveLength(conversations.length);
    expect(result.current.recents.showMore).toBe(false);
    expect(result.current.recents.showLess).toBe(true);

    // Collapse: back to default limit with "Show more"
    act(() => result.current.recents.onShowLess());

    expect(result.current.recents.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT,
    );
    expect(result.current.recents.showMore).toBe(true);
    expect(result.current.recents.showLess).toBe(false);
  });

  test("expanded state shows newly loaded items without re-expanding", () => {
    const page1 = Array.from({ length: 12 }, (_, i) => makeConversation(i));

    const { result, rerender } = renderHook(
      ({ conversations }) =>
        useSidebarState({ assistantId: "asst-1", conversations }),
      { initialProps: { conversations: page1 } },
    );

    // Expand
    act(() => result.current.recents.onShowMore());
    expect(result.current.recents.items).toHaveLength(12);

    // Simulate fetchNextPage loading more data
    const page1And2 = [
      ...page1,
      ...Array.from({ length: 12 }, (_, i) => makeConversation(i + 12)),
    ];
    rerender({ conversations: page1And2 });

    // All 24 items visible without needing to collapse and re-expand
    expect(result.current.recents.items).toHaveLength(24);
    expect(result.current.recents.showMore).toBe(false);
    expect(result.current.recents.showLess).toBe(true);
  });

  test("uses the same toggle behavior for Slack conversations", () => {
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

    // Collapsed
    expect(result.current.slack.items).toHaveLength(
      SIDEBAR_CONVERSATION_LIMIT,
    );
    expect(result.current.slack.showMore).toBe(true);
    expect(result.current.slack.showLess).toBe(false);

    // Expanded
    act(() => result.current.slack.onShowMore());

    expect(result.current.slack.items).toHaveLength(conversations.length);
    expect(result.current.slack.showMore).toBe(false);
    expect(result.current.slack.showLess).toBe(true);
  });

  test("onScrollLoadMore only fires when expanded, not when collapsed", () => {
    const fetchNextPage = mock(() => {});
    const conversations = Array.from({ length: 12 }, (_, i) =>
      makeConversation(i),
    );

    const { result, rerender } = renderHook(
      ({ hasNextPage }) =>
        useSidebarState({
          assistantId: "asst-1",
          conversations,
          fetchNextPage,
          hasNextPage,
        }),
      { initialProps: { hasNextPage: true } },
    );

    // Collapsed: onScrollLoadMore must be undefined to prevent the
    // IntersectionObserver sentinel from eagerly draining all server pages.
    expect(result.current.recents.onScrollLoadMore).toBeUndefined();

    // Expand the list (also fires fetchNextPage since hasNextPage is true)
    act(() => result.current.recents.onShowMore());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // Expanded + hasNextPage: onScrollLoadMore is defined
    expect(result.current.recents.onScrollLoadMore).toBeDefined();
    act(() => result.current.recents.onScrollLoadMore?.());
    expect(fetchNextPage).toHaveBeenCalledTimes(2);

    // When hasNextPage becomes false, onScrollLoadMore is undefined
    rerender({ hasNextPage: false });
    expect(result.current.recents.onScrollLoadMore).toBeUndefined();
  });

  test("onShowMore triggers fetchNextPage when server has more pages", () => {
    const fetchNextPage = mock(() => {});
    const conversations = Array.from({ length: 3 }, (_, i) =>
      makeConversation(i),
    );

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
        fetchNextPage,
        hasNextPage: true,
      }),
    );

    // With < SIDEBAR_CONVERSATION_LIMIT items but hasNextPage, showMore is visible
    expect(result.current.recents.showMore).toBe(true);

    // Clicking "Show more" triggers a page fetch
    act(() => result.current.recents.onShowMore());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  test("Show more and Show less are never both visible", () => {
    const conversations = Array.from({ length: 20 }, (_, index) =>
      makeConversation(index),
    );

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
      }),
    );

    // Collapsed state
    expect(result.current.recents.showMore && result.current.recents.showLess).toBe(false);

    // Expanded state
    act(() => result.current.recents.onShowMore());
    expect(result.current.recents.showMore && result.current.recents.showLess).toBe(false);

    // Back to collapsed
    act(() => result.current.recents.onShowLess());
    expect(result.current.recents.showMore && result.current.recents.showLess).toBe(false);
  });
});
