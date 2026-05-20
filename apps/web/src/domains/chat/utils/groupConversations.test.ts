import { describe, expect, test } from "bun:test";


import type { Conversation, ConversationGroup } from "@/domains/chat/api/conversations.js";
import {
  buildMoveToGroupTargets,
  getEffectiveGroupId,
  groupConversations,
} from "@/domains/chat/utils/groupConversations.js";

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    conversationKey: overrides.conversationKey ?? "k",
    ...overrides,
  };
}

describe("groupConversations · bucket routing", () => {
  test("returns empty buckets for an empty input", () => {
    const result = groupConversations([]);
    expect(result.pinned).toEqual([]);
    expect(result.scheduled).toEqual([]);
    expect(result.background).toEqual([]);
    expect(result.slack).toEqual([]);
    expect(result.recents).toEqual([]);
  });

  test("routes every isPinned:true conversation into the pinned bucket", () => {
    const result = groupConversations([
      makeConversation({ conversationKey: "a", isPinned: true }),
      makeConversation({ conversationKey: "b", isPinned: true }),
      makeConversation({ conversationKey: "c", isPinned: true }),
    ]);
    expect(result.pinned.map((c) => c.conversationKey)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.recents).toEqual([]);
    expect(result.scheduled).toEqual([]);
    expect(result.background).toEqual([]);
    expect(result.slack).toEqual([]);
  });

  test("routes conversationType=scheduled into scheduled bucket", () => {
    const result = groupConversations([
      makeConversation({
        conversationKey: "s1",
        conversationType: "scheduled",
      }),
      makeConversation({
        conversationKey: "s2",
        groupId: "system:scheduled",
      }),
    ]);
    expect(result.scheduled.map((c) => c.conversationKey).sort()).toEqual([
      "s1",
      "s2",
    ]);
    expect(result.recents).toEqual([]);
  });

  test("routes conversationType=background into background bucket", () => {
    const result = groupConversations([
      makeConversation({
        conversationKey: "b1",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({
        conversationKey: "b2",
        groupId: "system:background",
      }),
    ]);
    expect(result.background.map((c) => c.conversationKey).sort()).toEqual([
      "b1",
      "b2",
    ]);
  });

  test("routes Slack-origin conversations into the Slack bucket", () => {
    const result = groupConversations([
      makeConversation({ conversationKey: "regular" }),
      makeConversation({
        conversationKey: "slack-new",
        originChannel: "slack",
        groupId: "system:all",
        lastMessageAt: "2024-03-01T00:00:00Z",
      }),
      makeConversation({
        conversationKey: "slack-old",
        originChannel: "slack",
        lastMessageAt: "2024-01-01T00:00:00Z",
      }),
      makeConversation({
        conversationKey: "slack-scheduled",
        conversationType: "scheduled",
        originChannel: "slack",
      }),
      makeConversation({
        conversationKey: "slack-background",
        conversationType: "background",
        originChannel: "slack",
      }),
    ]);

    expect(result.slack.map((c) => c.conversationKey)).toEqual([
      "slack-new",
      "slack-old",
      "slack-scheduled",
      "slack-background",
    ]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual(["regular"]);
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
          conversationKey: "pinned-slack",
          isPinned: true,
          originChannel: "slack",
        }),
        makeConversation({
          conversationKey: "custom-slack",
          groupId: "grp-work",
          originChannel: "slack",
        }),
      ],
      {
        groups,
        customGroupsEnabled: true,
      },
    );

    expect(result.slack).toEqual([]);
    expect(result.pinned.map((c) => c.conversationKey)).toEqual([
      "pinned-slack",
    ]);
    expect(
      result.customGroups.find((g) => g.id === "grp-work")?.conversations.map(
        (c) => c.conversationKey,
      ),
    ).toEqual(["custom-slack"]);
  });

  test("keeps explicitly assigned scheduled and background Slack conversations in their system buckets", () => {
    const result = groupConversations([
      makeConversation({
        conversationKey: "scheduled-slack",
        groupId: "system:scheduled",
        originChannel: "slack",
      }),
      makeConversation({
        conversationKey: "background-slack",
        groupId: "system:background",
        originChannel: "slack",
      }),
    ]);

    expect(result.slack).toEqual([]);
    expect(result.scheduled.map((c) => c.conversationKey)).toEqual([
      "scheduled-slack",
    ]);
    expect(result.background.map((c) => c.conversationKey)).toEqual([
      "background-slack",
    ]);
  });

  test("treats Slack as a virtual effective group for move target filtering", () => {
    const conversation = makeConversation({
      conversationKey: "slack",
      originChannel: "slack",
    });

    expect(getEffectiveGroupId(conversation)).toBe("system:slack");
    expect(buildMoveToGroupTargets(conversation).map((g) => g.id)).toEqual([
      "system:pinned",
      "system:scheduled",
      "system:background",
      "system:all",
    ]);
  });

  test("routes background conversations with source=auto-analysis into background bucket", () => {
    // Auto-analysis (reflections) are a flavor of background — they land
    // in the background bucket and are sub-grouped downstream by
    // backgroundSubGroups.ts.
    const result = groupConversations([
      makeConversation({
        conversationKey: "r1",
        conversationType: "background",
        source: "auto-analysis",
      }),
      makeConversation({
        conversationKey: "r2",
        groupId: "system:background",
        source: "auto-analysis",
      }),
    ]);
    expect(result.background.map((c) => c.conversationKey).sort()).toEqual([
      "r1",
      "r2",
    ]);
  });

  test("does not reroute a foreground thread with source=auto-analysis", () => {
    // `source` alone is not enough — it must be a background thread.
    const result = groupConversations([
      makeConversation({ conversationKey: "a", source: "auto-analysis" }),
    ]);
    expect(result.background).toEqual([]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual(["a"]);
  });

  test("routes everything else (foreground, non-pinned) into recents", () => {
    const result = groupConversations([
      makeConversation({ conversationKey: "a" }),
      makeConversation({ conversationKey: "b", isPinned: false }),
      makeConversation({ conversationKey: "c" }),
    ]);
    expect(result.recents.map((c) => c.conversationKey).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("pinned takes precedence over every other classification", () => {
    // A pinned background-reflection should still show under Pinned.
    const result = groupConversations([
      makeConversation({
        conversationKey: "pinned-reflection",
        isPinned: true,
        conversationType: "background",
        source: "auto-analysis",
      }),
    ]);
    expect(result.pinned.map((c) => c.conversationKey)).toEqual([
      "pinned-reflection",
    ]);
    expect(result.background).toEqual([]);
  });

  test("excludes archived conversations from every bucket", () => {
    // archivedAt !== null means the thread is archived — it shouldn't
    // appear in the sidebar at all.
    const result = groupConversations([
      makeConversation({
        conversationKey: "archived",
        isPinned: true,
        archivedAt: 1700000000000,
      }),
      makeConversation({ conversationKey: "kept" }),
    ]);
    expect(result.pinned).toEqual([]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual(["kept"]);
  });
});

describe("groupConversations · recents ordering", () => {
  test("sorts recents by lastMessageAt descending", () => {
    const result = groupConversations([
      makeConversation({
        conversationKey: "old",
        lastMessageAt: "2024-01-01T00:00:00Z",
      }),
      makeConversation({
        conversationKey: "new",
        lastMessageAt: "2024-03-01T00:00:00Z",
      }),
      makeConversation({
        conversationKey: "mid",
        lastMessageAt: "2024-02-01T00:00:00Z",
      }),
    ]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  test("preserves input order for equal lastMessageAt timestamps", () => {
    const result = groupConversations([
      makeConversation({
        conversationKey: "first",
        lastMessageAt: "2024-01-01T00:00:00Z",
      }),
      makeConversation({
        conversationKey: "second",
        lastMessageAt: "2024-01-01T00:00:00Z",
      }),
    ]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual([
      "first",
      "second",
    ]);
  });

  test("treats a missing lastMessageAt as the oldest possible timestamp", () => {
    const result = groupConversations([
      makeConversation({ conversationKey: "missing" }),
      makeConversation({
        conversationKey: "dated",
        lastMessageAt: "2024-01-01T00:00:00Z",
      }),
    ]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual([
      "dated",
      "missing",
    ]);
  });

  test("does not mutate the input array", () => {
    const conversations = [
      makeConversation({
        conversationKey: "a",
        lastMessageAt: "2024-01-01T00:00:00Z",
      }),
      makeConversation({
        conversationKey: "b",
        lastMessageAt: "2024-02-01T00:00:00Z",
      }),
    ];
    const snapshotKeys = conversations.map((c) => c.conversationKey);
    groupConversations(conversations);
    expect(conversations.map((c) => c.conversationKey)).toEqual(snapshotKeys);
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

  test("routes conversations with non-system groupId into matching custom group when enabled", () => {
    const conversations = [
      makeConversation({ conversationKey: "w1", groupId: "grp-work" }),
      makeConversation({ conversationKey: "f1", groupId: "grp-fun" }),
      makeConversation({ conversationKey: "r1" }),
    ];
    const result = groupConversations(conversations, {
      groups,
      customGroupsEnabled: true,
    });

    expect(result.customGroups).toHaveLength(2);
    expect(
      result.customGroups.find((g) => g.id === "grp-work")?.conversations.map(
        (c) => c.conversationKey,
      ),
    ).toEqual(["w1"]);
    expect(
      result.customGroups.find((g) => g.id === "grp-fun")?.conversations.map(
        (c) => c.conversationKey,
      ),
    ).toEqual(["f1"]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual(["r1"]);
  });

  test("conversations with custom groupId fall through to recents when disabled", () => {
    const conversations = [
      makeConversation({ conversationKey: "w1", groupId: "grp-work" }),
      makeConversation({ conversationKey: "r1" }),
    ];
    const result = groupConversations(conversations, {
      groups,
      customGroupsEnabled: false,
    });

    expect(result.customGroups).toEqual([]);
    expect(result.recents.map((c) => c.conversationKey)).toContain("w1");
    expect(result.recents.map((c) => c.conversationKey)).toContain("r1");
  });

  test("conversations with custom groupId fall through to recents when no options provided", () => {
    const conversations = [
      makeConversation({ conversationKey: "w1", groupId: "grp-work" }),
    ];
    const result = groupConversations(conversations);

    expect(result.customGroups).toEqual([]);
    expect(result.recents.map((c) => c.conversationKey)).toEqual(["w1"]);
  });

  test("conversations with unknown custom groupId fall through to recents", () => {
    const conversations = [
      makeConversation({
        conversationKey: "x1",
        groupId: "grp-unknown",
      }),
    ];
    const result = groupConversations(conversations, {
      groups,
      customGroupsEnabled: true,
    });

    expect(result.recents.map((c) => c.conversationKey)).toEqual(["x1"]);
  });

  test("system groupIds are not routed to custom groups", () => {
    const conversations = [
      makeConversation({
        conversationKey: "s1",
        groupId: "system:pinned",
        isPinned: true,
      }),
      makeConversation({
        conversationKey: "s2",
        groupId: "system:scheduled",
      }),
    ];
    const result = groupConversations(conversations, {
      groups,
      customGroupsEnabled: true,
    });

    expect(result.pinned.map((c) => c.conversationKey)).toEqual(["s1"]);
    expect(result.scheduled.map((c) => c.conversationKey)).toEqual(["s2"]);
    expect(result.customGroups.every((g) => g.conversations.length === 0)).toBe(
      true,
    );
  });

  test("pinned conversations are not routed to custom groups", () => {
    const conversations = [
      makeConversation({
        conversationKey: "pw",
        isPinned: true,
        groupId: "grp-work",
      }),
    ];
    const result = groupConversations(conversations, {
      groups,
      customGroupsEnabled: true,
    });

    expect(result.pinned.map((c) => c.conversationKey)).toEqual(["pw"]);
    expect(
      result.customGroups.find((g) => g.id === "grp-work")?.conversations,
    ).toEqual([]);
  });

  test("system groups in the groups list are excluded from customGroups", () => {
    const groupsWithSystem: ConversationGroup[] = [
      makeGroup({ id: "system:pinned", name: "Pinned", isSystemGroup: true }),
      makeGroup({ id: "grp-work", name: "Work" }),
    ];
    const result = groupConversations([], {
      groups: groupsWithSystem,
      customGroupsEnabled: true,
    });

    expect(result.customGroups).toHaveLength(1);
    expect(result.customGroups[0]?.id).toBe("grp-work");
  });
});
