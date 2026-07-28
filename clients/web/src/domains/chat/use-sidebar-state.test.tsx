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

const { SIDEBAR_CONVERSATION_LIMIT, useSidebarState } =
  await import("@/domains/chat/use-sidebar-state");

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
      if (!section) {
        throw new Error("expected a slack channel section");
      }
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

describe("useSidebarState open-section persistence", () => {
  // Pinned/Chats and the channel sections share one accordion root, so every
  // toggle emits the whole value array — including sections that attention
  // forced open. Persisting those would outlive the attention that opened
  // them and leave the section stuck open across reloads.
  test("does not persist a section that only attention forced open", () => {
    const conversations = [
      makeConversation(0),
      makeConversation(1, {
        conversationId: "slack-1",
        originChannel: "slack",
        groupId: undefined,
      }),
    ];

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
        attentionConversationIds: new Set(["slack-1"]),
      }),
    );

    // Attention reveals the Slack section without the user touching it.
    expect(result.current.effectiveOpenSections).toContain("channel:slack");

    // Collapsing Chats emits the forced key alongside the real change.
    act(() =>
      result.current.onOpenSectionsChange(
        result.current.effectiveOpenSections.filter((k) => k !== "recents"),
      ),
    );

    expect(useSidebarCollapseStore.getState().openCategories).not.toContain(
      "channel:slack",
    );
    expect(useSidebarCollapseStore.getState().openPrimary).not.toContain(
      "recents",
    );
  });

  test("persists a section the user opened themselves", () => {
    const conversations = [
      makeConversation(0),
      makeConversation(1, {
        conversationId: "slack-1",
        originChannel: "slack",
        groupId: undefined,
      }),
    ];

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations }),
    );

    act(() =>
      result.current.onOpenSectionsChange([
        ...result.current.effectiveOpenSections,
        "channel:slack",
      ]),
    );

    expect(useSidebarCollapseStore.getState().openCategories).toContain(
      "channel:slack",
    );
  });
});

describe("useSidebarState custom-group open-section persistence", () => {
  // Custom groups render in their own accordion root, but attention forces
  // them open the same way the shared root's sections are forced open — so
  // their writes need the same filter, or a group the user never opened
  // stays expanded once the attention clears.
  test("does not persist a custom group that only attention forced open", () => {
    const conversations = [
      makeConversation(0, { conversationId: "g1", groupId: "grp-a" }),
      makeConversation(1, { conversationId: "g2", groupId: "grp-b" }),
    ];
    const conversationGroups = [
      { id: "grp-a", name: "Alpha", sortPosition: 0, isSystemGroup: false },
      { id: "grp-b", name: "Beta", sortPosition: 1, isSystemGroup: false },
    ];

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
        conversationGroups,
        attentionConversationIds: new Set(["g2"]),
      }),
    );

    expect(result.current.effectiveOpenCustomGroups).toContain("grp-b");

    // Opening Alpha emits Beta's forced key alongside the real change.
    act(() =>
      result.current.onOpenCustomGroupsChange([
        ...result.current.effectiveOpenCustomGroups,
        "grp-a",
      ]),
    );

    const stored = useSidebarCollapseStore.getState().openCustomGroups;
    expect(stored).toContain("grp-a");
    expect(stored).not.toContain("grp-b");
  });
});
