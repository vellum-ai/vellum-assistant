import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type * as ConversationQueries from "@/hooks/conversation-queries";
import type { SidebarIndexSection } from "@/utils/conversation-list-fetchers";
import type { Conversation } from "@/types/conversation-types";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
/* Type-only, so it is erased before the `mock.module` above takes effect and
   the dynamic `import` below is still what supplies the implementation. */
import type { SidebarState } from "@/domains/chat/use-sidebar-state";

/* The Background/Scheduled sections own their lazy queries; stub both so the
   hook resolves without a QueryClient.

   No section query is stubbed here: each section fetches its own rows where
   it renders (`useSectionConversations`). What this hook owns is the section
   *list* and the derived fallback rows, which is what these tests cover. */
/* Controls the stubbed section index per test. `null` is the feature-off
   answer (older daemon / unresolved read), which keeps every existing test on
   the derived-discovery path it was written against. */
let sidebarSectionsImpl: SidebarIndexSection[] | null = null;

mock.module(
  "@/hooks/conversation-queries",
  (): Partial<typeof ConversationQueries> => ({
    useSidebarSectionsQuery: () => sidebarSectionsImpl,
    useBackgroundConversationListQuery: () => ({
      conversations: [],
      isLoading: false,
      isPending: false,
      isError: false,
      refetch: () => {},
    }),
    useScheduledConversationListQuery: () => ({
      conversations: [],
      isLoading: false,
      isPending: false,
      isError: false,
      refetch: () => {},
    }),
  }),
);

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
  sidebarSectionsImpl = null;
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

  /** The Chats section, which is where this view's uncurated rows live. */
  function recentsIds(result: { current: SidebarState }): string[] {
    const recents = result.current.sections.find((s) => s.type === "recents");
    return (recents?.all ?? []).map((c) => c.conversationId);
  }

  test("merges the channel conversations into one recency-sorted list", () => {
    const { result } = renderSidebar();

    expect(
      result.current.sections.filter((section) => section.type === "channel"),
    ).toEqual([]);
    expect(recentsIds(result)).toEqual(["s1", "r1", "t1"]);
  });

  test("leaves pinned and grouped conversations out of the flat list", () => {
    const { result } = renderSidebar();

    expect(recentsIds(result)).not.toContain("p1");
    expect(recentsIds(result)).not.toContain("g1");
  });

  /* The uncurated rows are reachable as the Chats section and nowhere else.
     Asserts the count rather than merely that Chats holds them: one section
     holding them and a parallel list holding them too passes the tests above,
     and gives the collapsed rail two Chats tiles to draw. */
  test("publishes the uncurated rows once, as the Chats section", () => {
    const { result } = renderSidebar();

    const holders = result.current.sections.filter((section) =>
      section.all.some((c) => c.conversationId === "s1"),
    );
    expect(holders.map((s) => s.key)).toEqual(["recents"]);
    expect(Object.keys(result.current)).not.toContain("flatList");
  });

  /* Chats is a section in this view too, not a bare list under the curated
     ones. It used to be absent here, which is what made All view a different
     shape from Grouped rather than the same shape with the channel sections
     folded in: nothing owned the chat list, so it had no card, no header and
     no menu, and the menu is where the switch back to Grouped lives.

     What All view *doesn't* have is channel sections, which is the whole
     difference between the two views. */
  test("gives the flat list its own Chats section, with no channel sections", () => {
    const { result } = renderSidebar();

    expect(result.current.sections.map((s) => s.key)).toEqual([
      "pinned",
      "grp-a",
      "recents",
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
      result.current.onReorderSections(["grp-a", "channel:slack", "recents"]),
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

  /* A channel section may sit above a custom group. This used to be pulled
     back: sections were split into a curated tier (Pinned, the custom groups)
     and a governed one (Chats, the channels), and no order could cross the
     boundary, because the view switch was drawn on it. The switch moved into
     the sections' own menus, so the boundary has nothing left to protect, and
     the tier split was the last thing making a custom group a different kind
     of object from the chat list. */
  test("a channel section may be ordered above a custom group", () => {
    const { result } = renderSidebar();

    act(() =>
      result.current.onReorderSections(["channel:slack", "grp-a", "recents"]),
    );

    expect(result.current.sections.map((s) => s.key)).toEqual([
      "channel:slack",
      "grp-a",
      "recents",
    ]);
    // What renders is what persists, so the stored preference never describes
    // a layout the sidebar refuses to draw.
    expect(useSidebarLayoutStore.getState().sectionOrder).toEqual([
      "channel:slack",
      "grp-a",
      "recents",
    ]);
  });

  /* The ends of the list are the only thing left that refuses a nudge, and
     they refuse it by not offering it: `canMoveSection` is what the menu reads
     to decide whether to render the item at all, so a move it reports as
     unavailable is one the user is never shown (see `sectionMenu` in
     `assistant-side-menu.tsx`). Asserting the report and the no-op together,
     since a nudge that quietly does nothing while still being offered is the
     same dead action from the user's side. */
  test("onMoveSection nudges one slot and stops at the ends of the list", () => {
    const { result } = renderSidebar();

    // Slack starts last, and can walk all the way to the top now.
    act(() => result.current.onMoveSection("channel:slack", -1));
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "grp-a",
      "channel:slack",
      "recents",
    ]);

    expect(result.current.canMoveSection("channel:slack", -1)).toBe(true);
    act(() => result.current.onMoveSection("channel:slack", -1));
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "channel:slack",
      "grp-a",
      "recents",
    ]);

    // At the top there is nothing left to pass, so the move is not offered and
    // a call anyway changes nothing.
    expect(result.current.canMoveSection("channel:slack", -1)).toBe(false);
    act(() => result.current.onMoveSection("channel:slack", -1));
    expect(result.current.sections.map((s) => s.key)).toEqual([
      "channel:slack",
      "grp-a",
      "recents",
    ]);
  });

  test("a section that disappears keeps its slot for when it returns", () => {
    const { result, rerender } = renderSidebar();

    act(() =>
      result.current.onReorderSections(["grp-a", "channel:slack", "recents"]),
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
    act(() => quiet.result.current.onReorderSections(["grp-a", "recents"]));
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

/* Which sections exist still comes from the loaded list; what is in them
   comes from each section's own query. These cover the former. */
describe("useSidebarState curated sections", () => {
  test("omits Pinned when no loaded conversation is pinned", () => {
    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations: [makeConversation(1), makeConversation(2)],
      }),
    );

    expect(
      result.current.sections.find((s) => s.type === "pinned"),
    ).toBeUndefined();
  });

  test("lists a custom group even when no loaded conversation is in it", () => {
    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations: [makeConversation(1)],
        conversationGroups: [
          {
            id: "grp-work",
            name: "Work",
            sortPosition: 0,
            isSystemGroup: false,
          },
        ],
      }),
    );

    const work = result.current.sections.find((s) => s.key === "grp-work");
    expect(work).toBeDefined();
    expect(work?.label).toBe("Work");
  });
});

describe("useSidebarState with the section index", () => {
  test("a group absent from the index gets no section, present in it does", () => {
    const conversationGroups = [
      { id: "grp-empty", name: "Empty", sortPosition: 0, isSystemGroup: false },
      { id: "grp-full", name: "Full", sortPosition: 1, isSystemGroup: false },
    ];
    const conversations = [
      makeConversation(0, { conversationId: "g1", groupId: "grp-full" }),
    ];
    sidebarSectionsImpl = [
      {
        kind: "group",
        groupId: "grp-full",
        name: "Full",
        icon: null,
        sortPosition: 1,
        total: 1,
        unread: 0,
      },
      { kind: "chats", total: 0, unread: 0 },
    ];

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations,
        conversationGroups,
      }),
    );

    const keys = result.current.sections.map((s) => s.key);
    expect(keys).toContain("grp-full");
    // The empty group is the index's call, not the groups query's: it stays
    // a "Move to group" target but renders no card.
    expect(keys).not.toContain("grp-empty");
  });

  test("group metadata comes from the index snapshot, not the groups query", () => {
    const conversationGroups = [
      {
        id: "grp-a",
        name: "Stale name",
        sortPosition: 0,
        isSystemGroup: false,
      },
    ];
    sidebarSectionsImpl = [
      {
        kind: "group",
        groupId: "grp-a",
        name: "Fresh name",
        icon: null,
        sortPosition: 0,
        total: 2,
        unread: 0,
      },
      { kind: "chats", total: 0, unread: 0 },
    ];

    const { result } = renderHook(() =>
      useSidebarState({
        assistantId: "asst-1",
        conversations: [],
        conversationGroups,
      }),
    );

    const section = result.current.sections.find((s) => s.key === "grp-a");
    expect(section?.label).toBe("Fresh name");
  });

  test("Pinned exists exactly when the index says so", () => {
    // Derived pinned rows exist either way; the index decides the section.
    const conversations = [
      makeConversation(0, { conversationId: "p1", isPinned: true }),
    ];
    sidebarSectionsImpl = [{ kind: "chats", total: 0, unread: 0 }];

    const { result, rerender } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations }),
    );
    expect(result.current.sections.map((s) => s.key)).not.toContain("pinned");

    sidebarSectionsImpl = [
      { kind: "pinned", total: 1, unread: 0 },
      { kind: "chats", total: 0, unread: 0 },
    ];
    rerender();
    // The section exists per the index; its fallback rows are the derived
    // pinned bucket.
    expect(sectionFor(result.current.sections, "pinned").all).toHaveLength(1);
  });

  test("a channel section from the index renders even with no derived rows", () => {
    seedGroupedView();
    sidebarSectionsImpl = [
      { kind: "channel", channelId: "slack", total: 3, unread: 1 },
      { kind: "chats", total: 0, unread: 0 },
    ];

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations: [] }),
    );

    // Its own query fills the contents; existence must not wait for derived
    // rows the foreground page never carried.
    expect(sectionFor(result.current.sections, "channel:slack").all).toEqual(
      [],
    );
  });

  test("Chats renders in both discovery modes", () => {
    sidebarSectionsImpl = [{ kind: "chats", total: 0, unread: 0 }];
    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations: [] }),
    );
    expect(sectionFor(result.current.sections, "recents")).toBeDefined();
  });
});

describe("useSidebarState index unread threading", () => {
  test("sections carry the index's unread counts", () => {
    sidebarSectionsImpl = [
      { kind: "pinned", total: 3, unread: 2 },
      { kind: "chats", total: 5, unread: 1 },
    ];

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations: [] }),
    );

    expect(sectionFor(result.current.sections, "pinned")).toMatchObject({
      unread: 2,
    });
  });

  test("the flat view's Chats sums the native and channel buckets", () => {
    // The index buckets are disjoint, so the flat view's Chats holds all of
    // them; the derived rows cannot answer this once the list is windowed.
    sidebarSectionsImpl = [
      { kind: "chats", total: 2, unread: 1 },
      { kind: "channel", channelId: "slack", total: 4, unread: 2 },
    ];

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations: [] }),
    );

    expect(sectionFor(result.current.sections, "recents")).toMatchObject({
      unread: 3,
    });
  });

  test("the grouped view's Chats counts the native bucket alone", () => {
    seedGroupedView();
    sidebarSectionsImpl = [
      { kind: "chats", total: 2, unread: 1 },
      { kind: "channel", channelId: "slack", total: 4, unread: 2 },
    ];

    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations: [] }),
    );

    expect(sectionFor(result.current.sections, "recents")).toMatchObject({
      unread: 1,
    });
    expect(sectionFor(result.current.sections, "channel:slack")).toMatchObject({
      unread: 2,
    });
  });

  test("the derived path leaves unread undefined", () => {
    // No index means no whole-section truth; the indicator scans rows.
    const { result } = renderHook(() =>
      useSidebarState({ assistantId: "asst-1", conversations: [] }),
    );

    expect(sectionFor(result.current.sections, "recents")).not.toHaveProperty(
      "unread",
      expect.anything(),
    );
  });
});
