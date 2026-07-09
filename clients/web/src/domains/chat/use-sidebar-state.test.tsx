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
    // Mid-expansion offers only "Show more" — "Show less" waits until the
    // section is fully revealed so the two never render stacked together.
    expect(result.current.recents.showMore).toBe(true);
    expect(result.current.recents.showLess).toBe(false);

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

  test("uses the same incremental reveal behavior for channel sections", () => {
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

    const slackSection = () => {
      const section = result.current.channelSections.find(
        (s) => s.channelId === "slack",
      );
      if (!section) throw new Error("expected a slack channel section");
      return section;
    };

    expect(slackSection().items).toHaveLength(SIDEBAR_CONVERSATION_LIMIT);
    expect(slackSection().showMore).toBe(true);
    expect(slackSection().showLess).toBe(false);

    act(() => slackSection().onShowMore());

    expect(slackSection().items).toHaveLength(SIDEBAR_CONVERSATION_LIMIT * 2);
    expect(slackSection().showMore).toBe(true);
    expect(slackSection().showLess).toBe(false);
  });

  test("exposes one paginated section per origin channel", () => {
    const conversations = [
      makeConversation(0, { originChannel: "slack" }),
      makeConversation(1, { originChannel: "telegram" }),
      makeConversation(2, { originChannel: "telegram" }),
      makeConversation(3, {}),
    ];

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations }),
    );

    expect(result.current.channelSections.map((s) => s.channelId)).toEqual([
      "slack",
      "telegram",
    ]);
    expect(
      result.current.channelSections.find((s) => s.channelId === "telegram")
        ?.totalCount,
    ).toBe(2);
    expect(result.current.recents.totalCount).toBe(1);
  });
});
