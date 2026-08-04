import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "@/types/conversation-types";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";

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

const { useSidebarState } = await import("@/domains/chat/use-sidebar-state");

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
  useSidebarLayoutStore.setState({
    assistantId: null,
    openCategories: [],
    openCustomGroups: [],
    sectionOrder: [],
  });
});

/** The rendered section carrying `key`, or a clear failure if it is absent. */
function sectionFor(
  sections: { key: string; all: unknown[] }[],
  key: string,
): { key: string; all: unknown[] } {
  const section = sections.find((s) => s.key === key);
  if (!section) {
    throw new Error(`expected a "${key}" section`);
  }
  return section;
}

/**
 * Put the sidebar in the channel-grouped view. Seeding the key is enough: the
 * hook subscribes to storage during render, so the first render already sees
 * this - no store priming, and no commit in between.
 */
function seedGroupedView(assistantId = "asst-1"): void {
  localStorage.setItem(`vellum:sidebar-view-mode:${assistantId}`, "grouped");
}

describe("useSidebarState grouping", () => {
  // Sections hand over their whole conversation list; bounding and scrolling
  // it is the row list's job, so there is no page size or reveal state here.
  test("Chats carries every conversation, uncapped", () => {
    seedGroupedView();
    const conversations = Array.from({ length: 40 }, (_, index) =>
      makeConversation(index),
    );

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations }),
    );

    expect(sectionFor(result.current.sections, "recents").all).toHaveLength(40);
  });

  test("exposes one section per origin channel", () => {
    seedGroupedView();
    const conversations = [
      makeConversation(0, { originChannel: "slack" }),
      makeConversation(1, { originChannel: "telegram" }),
      makeConversation(2, { originChannel: "telegram" }),
      makeConversation(3, {}),
    ];

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations }),
    );

    expect(
      result.current.sections
        .filter((section) => section.type === "channel")
        .map((section) => section.key),
    ).toEqual(["channel:slack", "channel:telegram"]);
    expect(
      sectionFor(result.current.sections, "channel:telegram").all,
    ).toHaveLength(2);
    expect(sectionFor(result.current.sections, "recents").all).toHaveLength(1);
  });
});

describe("useSidebarState open-section persistence", () => {
  // Every section shares one accordion root, so every
  // toggle emits the whole value array — including sections that attention
  // forced open. Persisting those would outlive the attention that opened
  // them and leave the section stuck open across reloads.
  test("does not persist a section that only attention forced open", () => {
    seedGroupedView();
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

    expect(useSidebarLayoutStore.getState().openCategories).not.toContain(
      "channel:slack",
    );
    expect(useSidebarLayoutStore.getState().openPrimary).not.toContain(
      "recents",
    );
  });

  test("persists a section the user opened themselves", () => {
    seedGroupedView();
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

    expect(useSidebarLayoutStore.getState().openCategories).toContain(
      "channel:slack",
    );
  });
});

describe("useSidebarState custom-group open-section persistence", () => {
  // Custom groups share the one accordion root with every other section, and
  // attention forces them open the same way - so their writes need the same
  // filter, or a group the user never opened stays expanded once the
  // attention clears. The write must also land in the custom-group bucket,
  // not the primary or category bucket the same array carries.
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

    expect(result.current.effectiveOpenSections).toContain("grp-b");

    // Opening Alpha emits Beta's forced key alongside the real change.
    act(() =>
      result.current.onOpenSectionsChange([
        ...result.current.effectiveOpenSections,
        "grp-a",
      ]),
    );

    const stored = useSidebarLayoutStore.getState().openCustomGroups;
    expect(stored).toContain("grp-a");
    expect(stored).not.toContain("grp-b");
    // The shared array also carried "recents"; it must not leak into the
    // custom-group bucket.
    expect(stored).not.toContain("recents");
  });
});

describe("useSidebarState all view", () => {
  const conversations = [
    makeConversation(0, { conversationId: "r1", lastMessageAt: 30 }),
    makeConversation(1, {
      conversationId: "s1",
      originChannel: "slack",
      lastMessageAt: 40,
    }),
    makeConversation(2, {
      conversationId: "t1",
      originChannel: "telegram",
      lastMessageAt: 20,
    }),
    makeConversation(3, { conversationId: "p1", isPinned: true }),
    makeConversation(4, { conversationId: "g1", groupId: "grp-a" }),
  ];
  const conversationGroups = [
    { id: "grp-a", name: "Alpha", sortPosition: 0, isSystemGroup: false },
  ];

  function renderSidebar() {
    return renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
        conversationGroups,
      }),
    );
  }

  test("is the default view", () => {
    expect(renderSidebar().result.current.viewMode).toBe("all");
  });

  test("merges the channel conversations into one recency-sorted list", () => {
    const { result } = renderSidebar();

    expect(
      result.current.sections.filter((section) => section.type === "channel"),
    ).toEqual([]);
    expect(result.current.flatList.map((c) => c.conversationId)).toEqual([
      "s1",
      "r1",
      "t1",
    ]);
  });

  test("leaves pinned and grouped conversations out of the flat list", () => {
    const { result } = renderSidebar();

    const flatIds = result.current.flatList.map((c) => c.conversationId);
    expect(flatIds).not.toContain("p1");
    expect(flatIds).not.toContain("g1");
  });

  test("renders only the curated sections above the list", () => {
    const { result } = renderSidebar();

    expect(result.current.sections.map((s) => s.key)).toEqual([
      "pinned",
      "grp-a",
    ]);
  });

  test("switching views persists the choice for the assistant", () => {
    const { result } = renderSidebar();

    act(() => result.current.onViewModeChange("grouped"));

    expect(result.current.viewMode).toBe("grouped");
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "pinned",
      "grp-a",
      "recents",
      "channel:slack",
      "channel:telegram",
    ]);
  });
});

describe("useSidebarState section order", () => {
  const conversations = [
    makeConversation(0, { conversationId: "r1" }),
    makeConversation(1, { conversationId: "g1", groupId: "grp-a" }),
    makeConversation(2, {
      conversationId: "s1",
      originChannel: "slack",
      groupId: "system:all",
    }),
  ];
  const conversationGroups = [
    { id: "grp-a", name: "Alpha", sortPosition: 0, isSystemGroup: false },
  ];

  function renderSidebar() {
    seedGroupedView();
    return renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
        conversationGroups,
      }),
    );
  }

  test("defaults to custom groups above Chats and channel sections", () => {
    const { result } = renderSidebar();

    expect(result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "recents",
      "channel:slack",
    ]);
  });

  test("persists a reorder and applies it on the next render", () => {
    const { result } = renderSidebar();

    act(() =>
      result.current.onReorderSections([
        "grp-a",
        "channel:slack",
        "recents",
      ]),
    );

    expect(useSidebarLayoutStore.getState().sectionOrder).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);
  });

  test("a channel section settles back below the custom groups", () => {
    const { result } = renderSidebar();

    act(() =>
      result.current.onReorderSections([
        "channel:slack",
        "grp-a",
        "recents",
      ]),
    );

    expect(result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);
    // What renders is what persists, so the stored preference never describes
    // a layout the sidebar refuses to draw.
    expect(useSidebarLayoutStore.getState().sectionOrder).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);
  });

  test("a nudge that the channel floor would undo is not offered", () => {
    const { result } = renderSidebar();

    // Slack sits last, below Chats, which it may pass...
    expect(result.current.canMoveSection("channel:slack", -1)).toBe(true);
    act(() => result.current.onMoveSection("channel:slack", -1));
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);

    // ...but not the custom group above it.
    expect(result.current.canMoveSection("channel:slack", -1)).toBe(false);
  });

  test("onMoveSection nudges within a tier and stops at its boundary", () => {
    const { result } = renderSidebar();

    // Slack and Chats are both governed by the switch, so they swap freely.
    act(() => result.current.onMoveSection("channel:slack", -1));
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);

    // The next nudge would cross into the curated tier - refused, and
    // nothing is persisted.
    expect(result.current.canMoveSection("channel:slack", -1)).toBe(false);
    act(() => result.current.onMoveSection("channel:slack", -1));
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);
  });

  test("a section that disappears keeps its slot for when it returns", () => {
    const { result, rerender } = renderSidebar();

    act(() =>
      result.current.onReorderSections([
        "grp-a",
        "channel:slack",
        "recents",
      ]),
    );

    // Slack goes quiet: its section stops rendering entirely.
    const withoutSlack = conversations.filter((c) => c.conversationId !== "s1");
    rerender();
    const quiet = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations: withoutSlack,
        conversationGroups,
      }),
    );
    expect(quiet.result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "recents",
    ]);

    // Reordering while it's gone must not forget where it lived.
    act(() =>
      quiet.result.current.onReorderSections(["grp-a", "recents"]),
    );
    expect(useSidebarLayoutStore.getState().sectionOrder).toContain(
      "channel:slack",
    );

    // It comes back where the user left it: ahead of Chats.
    const back = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
        conversationGroups,
      }),
    );
    const keys = back.result.current.sections.map((s) => s.key);
    expect(keys.indexOf("channel:slack")).toBeLessThan(keys.indexOf("recents"));
  });
});
