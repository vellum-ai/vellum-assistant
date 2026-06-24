import { describe, expect, test } from "bun:test";


import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import { groupConversations } from "@/domains/chat/utils/group-conversations";

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
    expect(result.scheduled).toEqual([]);
    expect(result.background).toEqual([]);
    expect(result.channelSections).toEqual([]);
    expect(result.recents).toEqual([]);
  });

  test("routes every isPinned:true conversation into the pinned bucket", () => {
    const result = groupConversations([
      makeConversation({ conversationId: "a", isPinned: true }),
      makeConversation({ conversationId: "b", isPinned: true }),
      makeConversation({ conversationId: "c", isPinned: true }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.recents).toEqual([]);
    expect(result.scheduled).toEqual([]);
    expect(result.background).toEqual([]);
    expect(result.channelSections).toEqual([]);
  });

  test("routes conversationType=scheduled into scheduled bucket", () => {
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
    expect(result.scheduled.map((c) => c.conversationId).sort()).toEqual([
      "s1",
      "s2",
    ]);
    expect(result.recents).toEqual([]);
  });

  test("routes conversationType=background into background bucket", () => {
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
    expect(result.background.map((c) => c.conversationId).sort()).toEqual([
      "b1",
      "b2",
    ]);
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
    expect(result.scheduled).toEqual([]);
    expect(result.background).toEqual([]);
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
      result.customGroups.find((g) => g.id === "grp-work")?.conversations.map(
        (c) => c.conversationId,
      ),
    ).toEqual(["custom-slack"]);
  });

  test("keeps explicitly assigned scheduled and background Slack conversations in their system buckets", () => {
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
    expect(result.scheduled.map((c) => c.conversationId)).toEqual([
      "scheduled-slack",
    ]);
    expect(result.background.map((c) => c.conversationId)).toEqual([
      "background-slack",
    ]);
  });

  test("routes background conversations with source=auto-analysis into background bucket", () => {
    // Auto-analysis (reflections) are a flavor of background — they land
    // in the background bucket and are sub-grouped downstream by
    // backgroundSubGroups.ts.
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
    expect(result.background.map((c) => c.conversationId).sort()).toEqual([
      "r1",
      "r2",
    ]);
  });

  test("does not reroute a foreground thread with source=auto-analysis", () => {
    // `source` alone is not enough — it must be a background thread.
    const result = groupConversations([
      makeConversation({ conversationId: "a", source: "auto-analysis" }),
    ]);
    expect(result.background).toEqual([]);
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
    expect(result.background).toEqual([]);
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
      result.customGroups.find((g) => g.id === "grp-work")?.conversations.map(
        (c) => c.conversationId,
      ),
    ).toEqual(["w1"]);
    expect(
      result.customGroups.find((g) => g.id === "grp-fun")?.conversations.map(
        (c) => c.conversationId,
      ),
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
    expect(result.scheduled.map((c) => c.conversationId)).toEqual(["s2"]);
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

describe("groupConversations · displayOrder for pinned and custom groups", () => {
  test("pinned bucket sorts by displayOrder ascending (user-set order)", () => {
    // Note: input is provided newest-first by lastMessageAt to confirm the
    // pinned sort overrides recency, matching the bug described in LUM-1619.
    const result = groupConversations([
      makeConversation({
        conversationId: "b",
        isPinned: true,
        displayOrder: 1,
        lastMessageAt: 1704240000000,
      }),
      makeConversation({
        conversationId: "a",
        isPinned: true,
        displayOrder: 0,
        lastMessageAt: 1704153600000,
      }),
      makeConversation({
        conversationId: "c",
        isPinned: true,
        displayOrder: 2,
        lastMessageAt: 1704067200000,
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("pinned conversations without displayOrder fall back to createdAt desc, ignoring activity", () => {
    // lastMessageAt is the REVERSE of createdAt to prove the fallback keys on
    // immutable creation time, not recency — pinned rows must not reorder
    // themselves based on activity.
    const result = groupConversations([
      makeConversation({
        conversationId: "older",
        isPinned: true,
        createdAt: 1704067200000,
        lastMessageAt: 1704412800000, // most recent activity
      }),
      makeConversation({
        conversationId: "newer",
        isPinned: true,
        createdAt: 1704412800000,
        lastMessageAt: 1704067200000, // least recent activity
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationId)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("pinned order is stable when a pinned conversation receives new activity", () => {
    const base = [
      makeConversation({
        conversationId: "a",
        isPinned: true,
        createdAt: 3000,
        lastMessageAt: 100,
      }),
      makeConversation({
        conversationId: "b",
        isPinned: true,
        createdAt: 2000,
        lastMessageAt: 100,
      }),
      makeConversation({
        conversationId: "c",
        isPinned: true,
        createdAt: 1000,
        lastMessageAt: 100,
      }),
    ];
    const before = groupConversations(base).pinned.map((c) => c.conversationId);
    expect(before).toEqual(["a", "b", "c"]);

    // "c" gets a brand-new message — its lastMessageAt jumps far ahead. The
    // pinned order must not change.
    const after = groupConversations(
      base.map((c) =>
        c.conversationId === "c" ? { ...c, lastMessageAt: 9_999_999 } : c,
      ),
    ).pinned.map((c) => c.conversationId);
    expect(after).toEqual(before);
  });

  test("displayOrder rows come before rows without displayOrder", () => {
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
      "ordered-0",
      "no-order-newer",
    ]);
  });

  test("custom group conversations sort by displayOrder", () => {
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
          conversationId: "z",
          groupId: "grp-work",
          displayOrder: 2,
          lastMessageAt: 1704240000000,
        }),
        makeConversation({
          conversationId: "x",
          groupId: "grp-work",
          displayOrder: 0,
          lastMessageAt: 1704067200000,
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
      "x",
      "y",
      "z",
    ]);
  });
});

describe("groupConversations · surfaced promotion to recents", () => {
  test("a surfaced scheduled conversation lands in recents, not scheduled", () => {
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
    expect(result.scheduled.map((c) => c.conversationId)).toEqual([
      "sched-plain",
    ]);
  });

  test("a surfaced background conversation lands in recents, not background", () => {
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
    expect(result.background.map((c) => c.conversationId)).toEqual([
      "bg-plain",
    ]);
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
    expect(result.background).toEqual([]);
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
