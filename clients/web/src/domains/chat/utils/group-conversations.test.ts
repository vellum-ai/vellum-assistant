import { describe, expect, test } from "bun:test";

import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import type { GroupedConversations } from "@/domains/chat/utils/group-conversations";
import {
  buildMoveToGroupTargets,
  groupConversations,
} from "@/domains/chat/utils/group-conversations";

/**
 * Every conversation id the sidebar would render from a grouping result.
 *
 * Scheduled and background threads have no section, so the invariant worth
 * asserting is that they appear in NONE of these, not that they landed in a
 * bucket of their own. Checking `recents` alone would miss a leak into a
 * channel section or a custom group.
 */
function renderedIds(result: GroupedConversations): string[] {
  return [
    ...result.pinned,
    ...result.recents,
    ...result.customGroups.flatMap((g) => g.conversations),
    ...result.channelSections.flatMap((s) => s.conversations),
  ].map((c) => c.conversationId);
}

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    conversationId: overrides.conversationId ?? "k",
    ...overrides,
  };
}

/** Conversation ids in a given channel's section, or [] when absent. */
function channelSectionIds(
  result: ReturnType<typeof groupConversations>,
  channelId: string,
): string[] {
  return (
    result.channelSections
      .find((s) => s.channelId === channelId)
      ?.conversations.map((c) => c.conversationId) ?? []
  );
}

describe("groupConversations · bucket routing", () => {
  test("returns empty buckets for an empty input", () => {
    const result = groupConversations([]);
    expect(result.pinned).toEqual([]);
    expect(result.channelSections).toEqual([]);
    expect(result.recents).toEqual([]);
  });

  test("routes every isPinned:true conversation into the pinned bucket", () => {
    const result = groupConversations([
      makeConversation({ conversationId: "a", isPinned: true }),
      makeConversation({ conversationId: "b", isPinned: true }),
      makeConversation({ conversationId: "c", isPinned: true }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual(["a", "b", "c"]);
    expect(result.recents).toEqual([]);
    expect(result.channelSections).toEqual([]);
  });

  test("excludes conversationType=scheduled from every rendered bucket", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "s1",
        conversationType: "scheduled",
      }),
      makeConversation({
        conversationId: "s2",
        groupId: "system:scheduled",
      }),
    ]);
    // No section renders these.
    for (const id of ["s1", "s2"]) {
      expect(renderedIds(result)).not.toContain(id);
    }
    expect(result.recents).toEqual([]);
  });

  test("excludes conversationType=background from every rendered bucket", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "b1",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({
        conversationId: "b2",
        groupId: "system:background",
      }),
    ]);
    // No section renders these.
    for (const id of ["b1", "b2"]) {
      expect(renderedIds(result)).not.toContain(id);
    }
  });

  test("routes Slack-origin conversations into the Slack bucket", () => {
    const result = groupConversations([
      makeConversation({ conversationId: "regular" }),
      makeConversation({
        conversationId: "slack-new",
        originChannel: "slack",
        groupId: "system:all",
        lastMessageAt: 1709251200000,
      }),
      makeConversation({
        conversationId: "slack-old",
        originChannel: "slack",
        lastMessageAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "slack-scheduled",
        conversationType: "scheduled",
        originChannel: "slack",
      }),
      makeConversation({
        conversationId: "slack-background",
        conversationType: "background",
        originChannel: "slack",
      }),
    ]);

    expect(channelSectionIds(result, "slack")).toEqual([
      "slack-new",
      "slack-old",
      "slack-scheduled",
      "slack-background",
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["regular"]);
  });

  test("keeps pinned and custom-group Slack conversations in their explicit buckets", () => {
    const groups: ConversationGroup[] = [
      {
        id: "grp-work",
        name: "Work",
        sortPosition: 0,
        isSystemGroup: false,
      },
    ];
    const result = groupConversations(
      [
        makeConversation({
          conversationId: "pinned-slack",
          isPinned: true,
          originChannel: "slack",
        }),
        makeConversation({
          conversationId: "custom-slack",
          groupId: "grp-work",
          originChannel: "slack",
        }),
      ],
      { groups },
    );

    expect(result.channelSections).toEqual([]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "pinned-slack",
    ]);
    expect(
      result.customGroups
        .find((g) => g.id === "grp-work")
        ?.conversations.map((c) => c.conversationId),
    ).toEqual(["custom-slack"]);
  });

  test("excludes scheduled and background Slack conversations, channel or not", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "scheduled-slack",
        groupId: "system:scheduled",
        originChannel: "slack",
      }),
      makeConversation({
        conversationId: "background-slack",
        groupId: "system:background",
        originChannel: "slack",
      }),
    ]);

    expect(result.channelSections).toEqual([]);
    // An explicit system group takes them out of channel routing, so they
    // fall through to the exclusion rather than into the Slack section.
    for (const id of ["scheduled-slack", "background-slack"]) {
      expect(renderedIds(result)).not.toContain(id);
    }
  });

  test("excludes auto-analysis reflections like any other background thread", () => {
    // Auto-analysis (reflections) are a flavor of background, so they are
    // excluded on the same branch rather than treated as their own kind.
    const result = groupConversations([
      makeConversation({
        conversationId: "r1",
        conversationType: "background",
        source: "auto-analysis",
      }),
      makeConversation({
        conversationId: "r2",
        groupId: "system:background",
        source: "auto-analysis",
      }),
    ]);
    // No section renders these.
    for (const id of ["r1", "r2"]) {
      expect(renderedIds(result)).not.toContain(id);
    }
  });

  test("does not reroute a foreground thread with source=auto-analysis", () => {
    // `source` alone is not enough — it must be a background thread.
    const result = groupConversations([
      makeConversation({ conversationId: "a", source: "auto-analysis" }),
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["a"]);
  });

  test("routes everything else (foreground, non-pinned) into recents", () => {
    const result = groupConversations([
      makeConversation({ conversationId: "a" }),
      makeConversation({ conversationId: "b", isPinned: false }),
      makeConversation({ conversationId: "c" }),
    ]);
    expect(result.recents.map((c) => c.conversationId).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("pinned takes precedence over every other classification", () => {
    // A pinned background-reflection should still show under Pinned.
    const result = groupConversations([
      makeConversation({
        conversationId: "pinned-reflection",
        isPinned: true,
        conversationType: "background",
        source: "auto-analysis",
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "pinned-reflection",
    ]);
  });

  test("excludes archived conversations from every bucket", () => {
    // archivedAt !== null means the thread is archived — it shouldn't
    // appear in the sidebar at all.
    const result = groupConversations([
      makeConversation({
        conversationId: "archived",
        isPinned: true,
        archivedAt: 1700000000000,
      }),
      makeConversation({ conversationId: "kept" }),
    ]);
    expect(result.pinned).toEqual([]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["kept"]);
  });
});

describe("groupConversations · recents ordering", () => {
  test("sorts recents by lastMessageAt descending", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "old",
        lastMessageAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "new",
        lastMessageAt: 1709251200000,
      }),
      makeConversation({
        conversationId: "mid",
        lastMessageAt: 1706745600000,
      }),
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  test("preserves input order for equal lastMessageAt timestamps", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "first",
        lastMessageAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "second",
        lastMessageAt: 1704067200000,
      }),
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual([
      "first",
      "second",
    ]);
  });

  test("treats a missing lastMessageAt as the oldest possible timestamp", () => {
    const result = groupConversations([
      makeConversation({ conversationId: "missing" }),
      makeConversation({
        conversationId: "dated",
        lastMessageAt: 1704067200000,
      }),
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual([
      "dated",
      "missing",
    ]);
  });

  test("does not mutate the input array", () => {
    const conversations = [
      makeConversation({
        conversationId: "a",
        lastMessageAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "b",
        lastMessageAt: 1706745600000,
      }),
    ];
    const snapshotKeys = conversations.map((c) => c.conversationId);
    groupConversations(conversations);
    expect(conversations.map((c) => c.conversationId)).toEqual(snapshotKeys);
  });
});

// ---------------------------------------------------------------------------
// Custom groups
// ---------------------------------------------------------------------------

function makeGroup(
  overrides: Partial<ConversationGroup> & { id: string; name: string },
): ConversationGroup {
  return {
    sortPosition: 0,
    isSystemGroup: false,
    ...overrides,
  };
}

describe("groupConversations · custom group routing", () => {
  const groups: ConversationGroup[] = [
    makeGroup({ id: "grp-work", name: "Work" }),
    makeGroup({ id: "grp-fun", name: "Fun" }),
  ];

  test("routes conversations with non-system groupId into matching custom group", () => {
    const conversations = [
      makeConversation({ conversationId: "w1", groupId: "grp-work" }),
      makeConversation({ conversationId: "f1", groupId: "grp-fun" }),
      makeConversation({ conversationId: "r1" }),
    ];
    const result = groupConversations(conversations, { groups });

    expect(result.customGroups).toHaveLength(2);
    expect(
      result.customGroups
        .find((g) => g.id === "grp-work")
        ?.conversations.map((c) => c.conversationId),
    ).toEqual(["w1"]);
    expect(
      result.customGroups
        .find((g) => g.id === "grp-fun")
        ?.conversations.map((c) => c.conversationId),
    ).toEqual(["f1"]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["r1"]);
  });

  test("conversations with custom groupId fall through to recents when no groups provided", () => {
    const conversations = [
      makeConversation({ conversationId: "w1", groupId: "grp-work" }),
    ];
    const result = groupConversations(conversations);

    expect(result.customGroups).toEqual([]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["w1"]);
  });

  test("conversations with unknown custom groupId fall through to recents", () => {
    const conversations = [
      makeConversation({
        conversationId: "x1",
        groupId: "grp-unknown",
      }),
    ];
    const result = groupConversations(conversations, { groups });

    expect(result.recents.map((c) => c.conversationId)).toEqual(["x1"]);
  });

  test("system groupIds are not routed to custom groups", () => {
    const conversations = [
      makeConversation({
        conversationId: "s1",
        groupId: "system:pinned",
        isPinned: true,
      }),
      makeConversation({
        conversationId: "s2",
        groupId: "system:scheduled",
      }),
    ];
    const result = groupConversations(conversations, { groups });

    expect(result.pinned.map((c) => c.conversationId)).toEqual(["s1"]);
    // No section renders these.
    for (const id of ["s2"]) {
      expect(renderedIds(result)).not.toContain(id);
    }
    expect(result.customGroups.every((g) => g.conversations.length === 0)).toBe(
      true,
    );
  });

  test("pinned conversations are not routed to custom groups", () => {
    const conversations = [
      makeConversation({
        conversationId: "pw",
        isPinned: true,
        groupId: "grp-work",
      }),
    ];
    const result = groupConversations(conversations, { groups });

    expect(result.pinned.map((c) => c.conversationId)).toEqual(["pw"]);
    expect(
      result.customGroups.find((g) => g.id === "grp-work")?.conversations,
    ).toEqual([]);
  });

  test("system groups in the groups list are excluded from customGroups", () => {
    const groupsWithSystem: ConversationGroup[] = [
      makeGroup({ id: "system:pinned", name: "Pinned", isSystemGroup: true }),
      makeGroup({ id: "grp-work", name: "Work" }),
    ];
    const result = groupConversations([], { groups: groupsWithSystem });

    expect(result.customGroups).toHaveLength(1);
    expect(result.customGroups[0]?.id).toBe("grp-work");
  });
});

describe("groupConversations · recency order for pinned and custom groups", () => {
  /* Recency is the only order, for these sections as much as any other.
     `displayOrder` still exists on the wire and still carries values for
     anyone who arranged rows by hand before that affordance went away, so
     each test sets it to the REVERSE of the expected result: a comparator
     that consults it again fails here rather than passing by coincidence. */

  test("pinned sorts by recency, ignoring displayOrder", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "oldest",
        isPinned: true,
        displayOrder: 0,
        lastMessageAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "newest",
        isPinned: true,
        displayOrder: 2,
        lastMessageAt: 1704240000000,
      }),
      makeConversation({
        conversationId: "middle",
        isPinned: true,
        displayOrder: 1,
        lastMessageAt: 1704153600000,
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  test("a pinned conversation moves to the top when new activity arrives", () => {
    const base = [
      makeConversation({
        conversationId: "a",
        isPinned: true,
        createdAt: 3000,
        lastMessageAt: 300,
      }),
      makeConversation({
        conversationId: "b",
        isPinned: true,
        createdAt: 2000,
        lastMessageAt: 200,
      }),
      makeConversation({
        conversationId: "c",
        isPinned: true,
        createdAt: 1000,
        lastMessageAt: 100,
      }),
    ];
    expect(
      groupConversations(base).pinned.map((c) => c.conversationId),
    ).toEqual(["a", "b", "c"]);

    // "c" receives a brand-new message, so it leads. Under the old comparator
    // the order was pinned to creation time and would not have changed.
    const after = groupConversations(
      base.map((c) =>
        c.conversationId === "c" ? { ...c, lastMessageAt: 9_999_999 } : c,
      ),
    ).pinned.map((c) => c.conversationId);
    expect(after).toEqual(["c", "a", "b"]);
  });

  test("a row carrying displayOrder gets no precedence over one without", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "no-order-newer",
        isPinned: true,
        lastMessageAt: 1704844800000,
      }),
      makeConversation({
        conversationId: "ordered-0",
        isPinned: true,
        displayOrder: 0,
        lastMessageAt: 1704067200000,
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "no-order-newer",
      "ordered-0",
    ]);
  });

  test("custom group conversations sort by recency, ignoring displayOrder", () => {
    const groups: ConversationGroup[] = [
      {
        id: "grp-work",
        name: "Work",
        sortPosition: 0,
        isSystemGroup: false,
      },
    ];
    const result = groupConversations(
      [
        makeConversation({
          conversationId: "x",
          groupId: "grp-work",
          displayOrder: 0,
          lastMessageAt: 1704067200000,
        }),
        makeConversation({
          conversationId: "z",
          groupId: "grp-work",
          displayOrder: 2,
          lastMessageAt: 1704240000000,
        }),
        makeConversation({
          conversationId: "y",
          groupId: "grp-work",
          displayOrder: 1,
          lastMessageAt: 1704153600000,
        }),
      ],
      { groups },
    );
    const work = result.customGroups.find((g) => g.id === "grp-work");
    expect(work?.conversations.map((c) => c.conversationId)).toEqual([
      "z",
      "y",
      "x",
    ]);
  });
});

describe("groupConversations · surfaced promotion to recents", () => {
  test("a surfaced scheduled conversation reaches recents instead of being excluded", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "sched-surfaced",
        conversationType: "scheduled",
        surfacedAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "sched-plain",
        conversationType: "scheduled",
      }),
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual([
      "sched-surfaced",
    ]);
    // No section renders these.
    for (const id of ["sched-plain"]) {
      expect(renderedIds(result)).not.toContain(id);
    }
  });

  test("a surfaced background conversation reaches recents instead of being excluded", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "bg-surfaced",
        conversationType: "background",
        surfacedAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "bg-legacy-surfaced",
        groupId: "system:background",
        surfacedAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "bg-plain",
        conversationType: "background",
      }),
    ]);
    expect(result.recents.map((c) => c.conversationId).sort()).toEqual([
      "bg-legacy-surfaced",
      "bg-surfaced",
    ]);
    // No section renders these.
    for (const id of ["bg-plain"]) {
      expect(renderedIds(result)).not.toContain(id);
    }
  });

  test("surfaced conversations sort into recents by lastMessageAt desc", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "older-standard",
        lastMessageAt: 1704067200000,
      }),
      makeConversation({
        conversationId: "newer-surfaced",
        conversationType: "background",
        surfacedAt: 1,
        lastMessageAt: 1704153600000,
      }),
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual([
      "newer-surfaced",
      "older-standard",
    ]);
  });

  test("pinned wins over surfaced", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "pinned-surfaced",
        conversationType: "background",
        isPinned: true,
        surfacedAt: 1704067200000,
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "pinned-surfaced",
    ]);
    expect(result.recents).toEqual([]);
  });

  test("slack wins over surfaced", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "slack-surfaced",
        originChannel: "slack",
        surfacedAt: 1704067200000,
      }),
    ]);
    expect(channelSectionIds(result, "slack")).toEqual(["slack-surfaced"]);
    expect(result.recents).toEqual([]);
  });

  test("routes each non-Slack channel into its own section, ordered by channel id", () => {
    const result = groupConversations([
      makeConversation({ conversationId: "regular" }),
      makeConversation({
        conversationId: "tg-1",
        originChannel: "telegram",
        lastMessageAt: 1709251200000,
      }),
      makeConversation({
        conversationId: "tg-2",
        originChannel: "telegram",
        lastMessageAt: 1704067200000,
      }),
      makeConversation({ conversationId: "wa-1", originChannel: "whatsapp" }),
      makeConversation({ conversationId: "slack-1", originChannel: "slack" }),
    ]);

    // Sections are ordered by channel id (slack, telegram, whatsapp).
    expect(result.channelSections.map((s) => s.channelId)).toEqual([
      "slack",
      "telegram",
      "whatsapp",
    ]);
    // Within a section, conversations are recency-sorted.
    expect(channelSectionIds(result, "telegram")).toEqual(["tg-1", "tg-2"]);
    expect(channelSectionIds(result, "whatsapp")).toEqual(["wa-1"]);
    expect(channelSectionIds(result, "slack")).toEqual(["slack-1"]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["regular"]);
  });

  test("excludes native and notification origins from channel sections", () => {
    const result = groupConversations([
      makeConversation({ conversationId: "web", originChannel: "vellum" }),
      makeConversation({
        conversationId: "notif",
        originChannel: "notification:slack",
      }),
    ]);
    expect(result.channelSections).toEqual([]);
    expect(result.recents.map((c) => c.conversationId).sort()).toEqual([
      "notif",
      "web",
    ]);
  });

  test("archived surfaced conversations stay excluded", () => {
    const result = groupConversations([
      makeConversation({
        conversationId: "archived-surfaced",
        conversationType: "background",
        surfacedAt: 1704067200000,
        archivedAt: 1704153600000,
      }),
    ]);
    expect(result.recents).toEqual([]);
  });

  test("duplicate pinned conversations in input produce duplicate pinned entries", () => {
    // Demonstrates why upstream deduplication (in fetchConversationList)
    // is necessary: groupConversations trusts its input and does not
    // deduplicate, so the same pinned conversation appearing twice in
    // the input produces two entries in the pinned bucket.
    const result = groupConversations([
      makeConversation({
        conversationId: "pinned-1",
        isPinned: true,
        lastMessageAt: 5000,
      }),
      makeConversation({ conversationId: "regular", lastMessageAt: 4000 }),
      makeConversation({
        conversationId: "pinned-1",
        isPinned: true,
        lastMessageAt: 5000,
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "pinned-1",
      "pinned-1",
    ]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["regular"]);
  });
});

describe("groupConversations · groupByChannel: false", () => {
  test("channel conversations join recents instead of forming sections", () => {
    const result = groupConversations(
      [
        makeConversation({
          conversationId: "s1",
          originChannel: "slack",
          groupId: "system:all",
          lastMessageAt: 10,
        }),
        makeConversation({
          conversationId: "r1",
          groupId: "system:all",
          lastMessageAt: 20,
        }),
      ],
      { groupByChannel: false },
    );

    expect(result.channelSections).toEqual([]);
    expect(result.recents.map((c) => c.conversationId)).toEqual(["r1", "s1"]);
  });

  // Channel precedence sits above the scheduled/background routing in both
  // modes. Without that, a channel conversation carrying one of those types
  // would fall into a system bucket the sidebar never renders, and would be
  // visible in the grouped view but not the flat one.
  test("a channel conversation typed background still reaches recents", () => {
    const conversations = [
      makeConversation({
        conversationId: "s1",
        originChannel: "slack",
        groupId: "system:all",
        conversationType: "background",
      }),
    ];

    const flat = groupConversations(conversations, { groupByChannel: false });
    const grouped = groupConversations(conversations);

    expect(flat.recents.map((c) => c.conversationId)).toEqual(["s1"]);
    // Same membership in the grouped view, just a different bucket.
    expect(channelSectionIds(grouped, "slack")).toEqual(["s1"]);
  });

  test("pinned and custom-group precedence is unchanged", () => {
    const result = groupConversations(
      [
        makeConversation({
          conversationId: "p1",
          originChannel: "slack",
          isPinned: true,
        }),
        makeConversation({
          conversationId: "g1",
          originChannel: "telegram",
          groupId: "grp-a",
        }),
      ],
      {
        groupByChannel: false,
        groups: [
          {
            id: "grp-a",
            name: "Alpha",
            sortPosition: 0,
            isSystemGroup: false,
          },
        ] satisfies ConversationGroup[],
      },
    );

    expect(result.pinned.map((c) => c.conversationId)).toEqual(["p1"]);
    expect(
      result.customGroups[0]?.conversations.map((c) => c.conversationId),
    ).toEqual(["g1"]);
    expect(result.recents).toEqual([]);
  });
});

describe("buildMoveToGroupTargets", () => {
  const research = makeGroup({ id: "g_research", name: "Research" });
  const ideas = makeGroup({ id: "g_ideas", name: "Ideas" });
  const systemAll = makeGroup({
    id: "system:all",
    name: "Recents",
    isSystemGroup: true,
  });

  test("returns every custom group when the conversation is ungrouped", () => {
    const targets = buildMoveToGroupTargets(
      makeConversation({ conversationId: "c1" }),
      [research, ideas],
    );
    expect(targets).toEqual([
      { id: "g_research", name: "Research" },
      { id: "g_ideas", name: "Ideas" },
    ]);
  });

  test("excludes the conversation's current custom group", () => {
    const targets = buildMoveToGroupTargets(
      makeConversation({ conversationId: "c1", groupId: "g_research" }),
      [research, ideas],
    );
    expect(targets).toEqual([{ id: "g_ideas", name: "Ideas" }]);
  });

  test("never includes system groups (only custom folders are targets)", () => {
    const targets = buildMoveToGroupTargets(
      makeConversation({ conversationId: "c1" }),
      [systemAll, research],
    );
    expect(targets).toEqual([{ id: "g_research", name: "Research" }]);
  });

  test("returns an empty list when there are no custom groups", () => {
    expect(
      buildMoveToGroupTargets(makeConversation({ conversationId: "c1" }), []),
    ).toEqual([]);
    expect(
      buildMoveToGroupTargets(makeConversation({ conversationId: "c1" })),
    ).toEqual([]);
  });
});
