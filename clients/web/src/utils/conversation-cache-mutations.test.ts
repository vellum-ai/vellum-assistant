import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import type { GroupsGetResponse } from "@/generated/daemon/types.gen";
import {
  sidebarSectionsQueryKey,
  type ConversationListPage,
  type SidebarIndexSection,
} from "@/utils/conversation-list-fetchers";
import {
  ARCHIVED_FILTER,
  BACKGROUND_FILTER,
  conversationListQueryKey,
  SCHEDULED_FILTER,
} from "@/utils/conversation-list-keys";
import { listPage } from "@/utils/conversation-list.test-helper";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

import { mergeListFirstPage } from "@/utils/conversation-order";
import {
  adjustSectionUnreadCache,
  applySurfacedConversation,
  markConversationSeenLocal,
  prependConversation,
  removeConversation,
  shouldSurfaceConversation,
  surfaceConversationInCaches,
  resolveDraftKey,
  appendGroup,
  patchGroup,
  replaceOptimisticGroup,
  removeGroup,
  deleteGroupAndResetConversations,
} from "./conversation-cache-mutations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "ast-test";

function makeConversation(
  overrides: Partial<Conversation> & { conversationId: string },
): Conversation {
  return {
    title: "Test",
    createdAt: 1000,
    lastMessageAt: 2000,
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<ConversationGroup> & { id: string; name: string },
): ConversationGroup {
  return {
    sortPosition: 0,
    isSystemGroup: false,
    ...overrides,
  } as ConversationGroup;
}

function seedForeground(qc: QueryClient, conversations: Conversation[]) {
  qc.setQueryData(
    conversationListQueryKey(ASSISTANT_ID),
    listPage(conversations),
  );
}

function seedBackground(qc: QueryClient, conversations: Conversation[]) {
  qc.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, BACKGROUND_FILTER),
    listPage(conversations),
  );
}

function seedScheduled(qc: QueryClient, conversations: Conversation[]) {
  qc.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, SCHEDULED_FILTER),
    listPage(conversations),
  );
}

function seedArchived(qc: QueryClient, conversations: Conversation[]) {
  qc.setQueryData(
    conversationListQueryKey(ASSISTANT_ID, ARCHIVED_FILTER),
    listPage(conversations),
  );
}

function seedGroups(qc: QueryClient, groups: ConversationGroup[]) {
  qc.setQueryData<GroupsGetResponse>(
    groupsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    { groups },
  );
}

function getForeground(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<ConversationListPage>(
      conversationListQueryKey(ASSISTANT_ID),
    )?.conversations ?? []
  );
}

function getBackground(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<ConversationListPage>(
      conversationListQueryKey(ASSISTANT_ID, BACKGROUND_FILTER),
    )?.conversations ?? []
  );
}

function getScheduled(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<ConversationListPage>(
      conversationListQueryKey(ASSISTANT_ID, SCHEDULED_FILTER),
    )?.conversations ?? []
  );
}

function getArchived(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<ConversationListPage>(
      conversationListQueryKey(ASSISTANT_ID, ARCHIVED_FILTER),
    )?.conversations ?? []
  );
}

function getGroups(qc: QueryClient): ConversationGroup[] {
  return (
    qc.getQueryData<GroupsGetResponse>(
      groupsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
    )?.groups ?? []
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

// ---------------------------------------------------------------------------
// markConversationSeenLocal
// ---------------------------------------------------------------------------

describe("markConversationSeenLocal", () => {
  test("clears unseen flag and sets lastSeenAssistantMessageAt from latestAssistantMessageAt", () => {
    seedForeground(qc, [
      makeConversation({
        conversationId: "c1",
        hasUnseenLatestAssistantMessage: true,
        latestAssistantMessageAt: 5000,
        lastSeenAssistantMessageAt: 3000,
      }),
    ]);

    markConversationSeenLocal(qc, ASSISTANT_ID, "c1");

    const [c] = getForeground(qc);
    expect(c.hasUnseenLatestAssistantMessage).toBe(false);
    expect(c.lastSeenAssistantMessageAt).toBe(5000);
  });

  test("uses explicit lastSeenAssistantMessageAt when provided", () => {
    seedForeground(qc, [
      makeConversation({
        conversationId: "c1",
        hasUnseenLatestAssistantMessage: true,
        latestAssistantMessageAt: 5000,
      }),
    ]);

    markConversationSeenLocal(qc, ASSISTANT_ID, "c1", 9999);

    const [c] = getForeground(qc);
    expect(c.lastSeenAssistantMessageAt).toBe(9999);
  });

  test("falls back to existing lastSeenAssistantMessageAt when latestAssistantMessageAt is absent", () => {
    seedForeground(qc, [
      makeConversation({
        conversationId: "c1",
        hasUnseenLatestAssistantMessage: true,
        lastSeenAssistantMessageAt: 3000,
      }),
    ]);

    markConversationSeenLocal(qc, ASSISTANT_ID, "c1");

    const [c] = getForeground(qc);
    expect(c.lastSeenAssistantMessageAt).toBe(3000);
  });

  test("updates conversation in background cache", () => {
    seedBackground(qc, [
      makeConversation({
        conversationId: "bg1",
        hasUnseenLatestAssistantMessage: true,
        latestAssistantMessageAt: 7000,
        conversationType: "background",
      }),
    ]);

    markConversationSeenLocal(qc, ASSISTANT_ID, "bg1");

    const [c] = getBackground(qc);
    expect(c.hasUnseenLatestAssistantMessage).toBe(false);
    expect(c.lastSeenAssistantMessageAt).toBe(7000);
  });

  test("no-op when conversation not found", () => {
    const original = [makeConversation({ conversationId: "c1" })];
    seedForeground(qc, original);

    markConversationSeenLocal(qc, ASSISTANT_ID, "nonexistent");

    expect(getForeground(qc)).toBe(original);
  });

  test("no-op when assistantId is null", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);

    markConversationSeenLocal(qc, null, "c1");

    // Original foreground under ASSISTANT_ID is unchanged
    const [c] = getForeground(qc);
    expect(c.hasUnseenLatestAssistantMessage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// prependConversation
// ---------------------------------------------------------------------------

describe("prependConversation", () => {
  test("inserts conversation at front of foreground cache", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);

    const newConv = makeConversation({ conversationId: "c2" });
    prependConversation(qc, ASSISTANT_ID, newConv);

    const list = getForeground(qc);
    expect(list).toHaveLength(2);
    expect(list[0].conversationId).toBe("c2");
    expect(list[1].conversationId).toBe("c1");
  });

  test("works on empty cache", () => {
    seedForeground(qc, []);

    prependConversation(
      qc,
      ASSISTANT_ID,
      makeConversation({ conversationId: "c1" }),
    );

    expect(getForeground(qc)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeConversation
// ---------------------------------------------------------------------------

describe("removeConversation", () => {
  test("removes from foreground cache", () => {
    seedForeground(qc, [
      makeConversation({ conversationId: "c1" }),
      makeConversation({ conversationId: "c2" }),
    ]);

    removeConversation(qc, ASSISTANT_ID, "c1");

    const list = getForeground(qc);
    expect(list).toHaveLength(1);
    expect(list[0].conversationId).toBe("c2");
  });

  test("removes from background cache", () => {
    seedBackground(qc, [
      makeConversation({
        conversationId: "bg1",
        conversationType: "background",
      }),
    ]);

    removeConversation(qc, ASSISTANT_ID, "bg1");

    expect(getBackground(qc)).toHaveLength(0);
  });

  test("removes from scheduled cache", () => {
    seedScheduled(qc, [
      makeConversation({ conversationId: "s1", conversationType: "scheduled" }),
    ]);

    removeConversation(qc, ASSISTANT_ID, "s1");

    expect(getScheduled(qc)).toHaveLength(0);
  });

  test("removes from archived cache", () => {
    seedArchived(qc, [makeConversation({ conversationId: "a1" })]);

    removeConversation(qc, ASSISTANT_ID, "a1");

    expect(getArchived(qc)).toHaveLength(0);
  });

  test("returns same reference when conversation not found", () => {
    const original = [makeConversation({ conversationId: "c1" })];
    seedForeground(qc, original);

    removeConversation(qc, ASSISTANT_ID, "nonexistent");

    expect(getForeground(qc)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// surfaceConversationInCaches
// ---------------------------------------------------------------------------

describe("shouldSurfaceConversation", () => {
  test("a subagent-sourced run is never surfaceable", () => {
    // The daemon's surfaced visibility arm excludes subagent runs; a
    // surface POST could never make one listable.
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "sub1",
          conversationType: "background",
          source: "subagent",
        }),
      ),
    ).toBe(false);
  });

  test("allows unsurfaced scheduled and background conversations", () => {
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "scheduled-1",
          conversationType: "scheduled",
        }),
      ),
    ).toBe(true);
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "background-1",
          conversationType: "background",
        }),
      ),
    ).toBe(true);
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "legacy-scheduled-1",
          groupId: "system:scheduled",
        }),
      ),
    ).toBe(true);
  });

  test("skips conversations already displayed outside run buckets", () => {
    expect(
      shouldSurfaceConversation(
        makeConversation({ conversationId: "standard-1" }),
      ),
    ).toBe(false);
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "surfaced-1",
          conversationType: "scheduled",
          surfacedAt: 9000,
        }),
      ),
    ).toBe(false);
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "pinned-1",
          conversationType: "background",
          isPinned: true,
        }),
      ),
    ).toBe(false);
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "custom-1",
          conversationType: "scheduled",
          groupId: "group-custom",
        }),
      ),
    ).toBe(false);
    expect(
      shouldSurfaceConversation(
        makeConversation({
          conversationId: "archived-1",
          conversationType: "background",
          archivedAt: 7000,
        }),
      ),
    ).toBe(false);
  });
});

describe("surfaceConversationInCaches", () => {
  test("prepends a scheduled conversation to foreground Recents and patches its existing cache row", () => {
    seedForeground(qc, [makeConversation({ conversationId: "existing" })]);
    seedScheduled(qc, [
      makeConversation({
        conversationId: "run-1",
        conversationType: "scheduled",
        groupId: "system:scheduled",
        lastMessageAt: 3000,
      }),
    ]);

    surfaceConversationInCaches(
      qc,
      ASSISTANT_ID,
      getScheduled(qc)[0]!,
      9000,
      8000,
    );

    expect(getForeground(qc).map((c) => c.conversationId)).toEqual([
      "run-1",
      "existing",
    ]);
    expect(getForeground(qc)[0]).toMatchObject({
      conversationId: "run-1",
      groupId: "system:all",
      surfacedAt: 9000,
      lastMessageAt: 8000,
    });
    expect(getScheduled(qc)[0]).toMatchObject({
      conversationId: "run-1",
      groupId: "system:all",
      surfacedAt: 9000,
    });
  });

  test("prepends the fetched conversation when no lazy run cache has loaded", () => {
    seedForeground(qc, [makeConversation({ conversationId: "existing" })]);
    const runConversation = makeConversation({
      conversationId: "run-1",
      conversationType: "background",
      groupId: "system:background",
    });

    surfaceConversationInCaches(qc, ASSISTANT_ID, runConversation, 9000, 8500);

    expect(getForeground(qc)[0]).toMatchObject({
      conversationId: "run-1",
      groupId: "system:all",
      surfacedAt: 9000,
      lastMessageAt: 8500,
    });
    expect(getBackground(qc)).toEqual([]);
  });

  test("keeps the newer existing lastMessageAt when the caller timestamp is older", () => {
    seedBackground(qc, [
      makeConversation({
        conversationId: "run-1",
        conversationType: "background",
        lastMessageAt: 9500,
      }),
    ]);

    surfaceConversationInCaches(
      qc,
      ASSISTANT_ID,
      getBackground(qc)[0]!,
      9000,
      8500,
    );

    expect(getForeground(qc)[0]?.lastMessageAt).toBe(9500);
  });
});

// ---------------------------------------------------------------------------
// resolveDraftKey
// ---------------------------------------------------------------------------

describe("resolveDraftKey", () => {
  test("replaces conversationId and clears draft flag", () => {
    seedForeground(qc, [
      makeConversation({ conversationId: "draft-123", draft: true }),
    ]);

    resolveDraftKey(qc, ASSISTANT_ID, "draft-123", "real-456");

    const [c] = getForeground(qc);
    expect(c.conversationId).toBe("real-456");
    expect(c.draft).toBe(false);
  });

  test("no-op when draft key not found", () => {
    const original = [makeConversation({ conversationId: "c1" })];
    seedForeground(qc, original);

    resolveDraftKey(qc, ASSISTANT_ID, "nonexistent", "real-456");

    expect(getForeground(qc)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Group cache helpers
// ---------------------------------------------------------------------------

describe("appendGroup", () => {
  test("appends group to existing list", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "First" })]);

    appendGroup(qc, ASSISTANT_ID, makeGroup({ id: "g2", name: "Second" }));

    const groups = getGroups(qc);
    expect(groups).toHaveLength(2);
    expect(groups[1].id).toBe("g2");
    expect(groups[1].name).toBe("Second");
  });

  test("falls back to list length when sortPosition is undefined", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "First" })]);

    const group = makeGroup({ id: "g2", name: "Second" });
    // Simulate undefined sortPosition (as if omitted by caller)
    (group as Record<string, unknown>).sortPosition = undefined;
    appendGroup(qc, ASSISTANT_ID, group);

    const groups = getGroups(qc);
    expect(groups[1].sortPosition).toBe(1);
  });

  test("preserves sortPosition of 0", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "First" })]);

    appendGroup(
      qc,
      ASSISTANT_ID,
      makeGroup({ id: "g2", name: "Second", sortPosition: 0 }),
    );

    expect(getGroups(qc)[1].sortPosition).toBe(0);
  });

  test("preserves explicit non-zero sortPosition", () => {
    seedGroups(qc, []);

    appendGroup(
      qc,
      ASSISTANT_ID,
      makeGroup({ id: "g1", name: "First", sortPosition: 5 }),
    );

    expect(getGroups(qc)[0].sortPosition).toBe(5);
  });
});

describe("patchGroup", () => {
  test("patches matching group", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Old Name" })]);

    patchGroup(qc, ASSISTANT_ID, "g1", { name: "New Name" });

    expect(getGroups(qc)[0].name).toBe("New Name");
  });

  test("no-op when group not found", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Existing" })]);

    patchGroup(qc, ASSISTANT_ID, "nonexistent", { name: "Nope" });

    expect(getGroups(qc)[0].name).toBe("Existing");
  });
});

describe("replaceOptimisticGroup", () => {
  test("replaces optimistic group with server group", () => {
    seedGroups(qc, [makeGroup({ id: "optimistic-1", name: "Draft" })]);

    const serverGroup = makeGroup({
      id: "real-1",
      name: "Server Name",
      sortPosition: 3,
    });
    replaceOptimisticGroup(qc, ASSISTANT_ID, "optimistic-1", serverGroup);

    const groups = getGroups(qc);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("real-1");
    expect(groups[0].name).toBe("Server Name");
  });

  test("no-op when optimistic id not found", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Existing" })]);

    replaceOptimisticGroup(
      qc,
      ASSISTANT_ID,
      "nonexistent",
      makeGroup({ id: "g2", name: "New" }),
    );

    const groups = getGroups(qc);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("g1");
  });
});

describe("removeGroup", () => {
  test("removes matching group", () => {
    seedGroups(qc, [
      makeGroup({ id: "g1", name: "Keep" }),
      makeGroup({ id: "g2", name: "Remove" }),
    ]);

    removeGroup(qc, ASSISTANT_ID, "g2");

    const groups = getGroups(qc);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("g1");
  });

  test("no-op when group not found", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Keep" })]);

    removeGroup(qc, ASSISTANT_ID, "nonexistent");

    expect(getGroups(qc)).toHaveLength(1);
  });
});

describe("deleteGroupAndResetConversations", () => {
  test("removes group and clears groupId from conversations", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Doomed" })]);
    seedForeground(qc, [
      makeConversation({ conversationId: "c1", groupId: "g1" }),
      makeConversation({ conversationId: "c2", groupId: "g2" }),
    ]);

    deleteGroupAndResetConversations(qc, ASSISTANT_ID, "g1");

    expect(getGroups(qc)).toHaveLength(0);

    const convs = getForeground(qc);
    expect(convs[0].groupId).toBeUndefined();
    expect(convs[1].groupId).toBe("g2");
  });

  test("clears groupId across all caches including archived", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Delete" })]);
    seedForeground(qc, [
      makeConversation({ conversationId: "c1", groupId: "g1" }),
    ]);
    seedBackground(qc, [
      makeConversation({
        conversationId: "bg1",
        groupId: "g1",
        conversationType: "background",
      }),
    ]);
    seedScheduled(qc, [
      makeConversation({
        conversationId: "s1",
        groupId: "g1",
        conversationType: "scheduled",
      }),
    ]);
    seedArchived(qc, [
      makeConversation({ conversationId: "a1", groupId: "g1" }),
    ]);

    deleteGroupAndResetConversations(qc, ASSISTANT_ID, "g1");

    expect(getForeground(qc)[0].groupId).toBeUndefined();
    expect(getBackground(qc)[0].groupId).toBeUndefined();
    expect(getScheduled(qc)[0].groupId).toBeUndefined();
    expect(getArchived(qc)[0].groupId).toBeUndefined();
  });

  test("no-op on conversations when no conversations have the groupId", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Delete" })]);
    const original = [
      makeConversation({ conversationId: "c1", groupId: "other" }),
    ];
    seedForeground(qc, original);

    deleteGroupAndResetConversations(qc, ASSISTANT_ID, "g1");

    expect(getForeground(qc)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// mergeListFirstPage
// ---------------------------------------------------------------------------

describe("mergeListFirstPage", () => {
  test("replaces the cache when the page is the complete list", () => {
    const prev = [
      makeConversation({ conversationId: "c1", lastMessageAt: 5000 }),
      makeConversation({ conversationId: "c2", lastMessageAt: 1000 }),
    ];
    const page = {
      conversations: [
        makeConversation({ conversationId: "c1", lastMessageAt: 5000 }),
      ],
      hasMore: false,
    };

    expect(
      mergeListFirstPage(listPage(prev), page, { pinnedInjected: true }),
    ).toBe(page);
  });

  test("drops cached rows inside the window that vanished from the page, keeps older rows", () => {
    const prev = [
      makeConversation({ conversationId: "c-new", lastMessageAt: 5000 }),
      makeConversation({ conversationId: "c-gone", lastMessageAt: 4950 }),
      makeConversation({ conversationId: "c-old", lastMessageAt: 1000 }),
    ];
    const fresh = [
      makeConversation({
        conversationId: "c-new",
        lastMessageAt: 5000,
        title: "Renamed",
      }),
      makeConversation({ conversationId: "c-created", lastMessageAt: 4900 }),
    ];

    const merged = mergeListFirstPage(
      listPage(prev),
      { conversations: fresh, hasMore: true },
      { pinnedInjected: true },
    );

    expect(merged.conversations.map((c) => c.conversationId)).toEqual([
      "c-new",
      "c-created",
      "c-old",
    ]);
    expect(merged.conversations[0].title).toBe("Renamed");
    expect(merged.hasMore).toBe(true);
  });

  test("excludes injected pinned rows from the window cutoff", () => {
    // The daemon appends every pinned conversation to page 1 regardless of
    // age. An ancient pinned row must not collapse the cutoff and drop
    // live cached rows.
    const prev = [
      makeConversation({ conversationId: "c-live", lastMessageAt: 4000 }),
    ];
    const fresh = [
      makeConversation({ conversationId: "c-top", lastMessageAt: 5000 }),
      makeConversation({
        conversationId: "c-pinned",
        lastMessageAt: 100,
        isPinned: true,
      }),
    ];

    const merged = mergeListFirstPage(
      listPage(prev),
      { conversations: fresh, hasMore: true },
      { pinnedInjected: true },
    );

    expect(merged.conversations.map((c) => c.conversationId)).toEqual([
      "c-top",
      "c-pinned",
      "c-live",
    ]);
  });

  test("always keeps client-local draft rows", () => {
    const prev = [
      makeConversation({
        conversationId: "c-draft",
        lastMessageAt: 6000,
        draft: true,
      }),
    ];
    const fresh = [
      makeConversation({ conversationId: "c-top", lastMessageAt: 5000 }),
    ];

    const merged = mergeListFirstPage(
      listPage(prev),
      { conversations: fresh, hasMore: true },
      { pinnedInjected: true },
    );

    expect(merged.conversations.map((c) => c.conversationId)).toEqual([
      "c-top",
      "c-draft",
    ]);
  });

  test("returns the cache unchanged when every injected fresh row is pinned", () => {
    const prev = [
      makeConversation({ conversationId: "c1", lastMessageAt: 4000 }),
    ];
    const fresh = [
      makeConversation({
        conversationId: "c-pinned",
        lastMessageAt: 100,
        isPinned: true,
      }),
    ];

    const prevPage = listPage(prev, true);
    expect(
      mergeListFirstPage(
        prevPage,
        { conversations: fresh, hasMore: true },
        { pinnedInjected: true },
      ),
    ).toBe(prevPage);
  });

  test("a section page counts its pinned rows toward the cutoff", () => {
    /* A section page has no injection, so its pinned rows are genuine
       window members. In the Pinned section every row is pinned; excluding
       them under the injection rule would leave no window at all, and the
       refresh would silently do nothing. */
    const prev = [
      makeConversation({ conversationId: "c-stale", lastMessageAt: 4000 }),
      makeConversation({ conversationId: "c-older", lastMessageAt: 100 }),
    ];
    const fresh = [
      makeConversation({
        conversationId: "c-pin-a",
        lastMessageAt: 5000,
        isPinned: true,
      }),
      makeConversation({
        conversationId: "c-pin-b",
        lastMessageAt: 3000,
        isPinned: true,
      }),
    ];

    const merged = mergeListFirstPage(
      listPage(prev),
      { conversations: fresh, hasMore: true },
      { pinnedInjected: false },
    );

    // c-stale sits inside the window (>= 3000) but vanished from the page,
    // so it is dropped; c-older sorts below the window and survives.
    expect(merged.conversations.map((c) => c.conversationId)).toEqual([
      "c-pin-a",
      "c-pin-b",
      "c-older",
    ]);
  });
});

// ---------------------------------------------------------------------------
// adjustSectionUnreadCache
// ---------------------------------------------------------------------------

describe("adjustSectionUnreadCache", () => {
  const INDEX_KEY = sidebarSectionsQueryKey(ASSISTANT_ID);

  function seedIndex(client: QueryClient): SidebarIndexSection[] {
    const index: SidebarIndexSection[] = [
      { kind: "pinned", total: 2, unread: 1 },
      {
        kind: "group",
        groupId: "grp-1",
        name: "G",
        icon: null,
        sortPosition: 0,
        total: 3,
        unread: 2,
      },
      { kind: "channel", channelId: "slack", total: 4, unread: 1 },
      { kind: "chats", total: 5, unread: 3 },
    ];
    client.setQueryData<SidebarIndexSection[] | null>(INDEX_KEY, index);
    return index;
  }

  function unreadOf(
    client: QueryClient,
    match: (s: SidebarIndexSection) => boolean,
  ): number | undefined {
    return client.getQueryData<SidebarIndexSection[]>(INDEX_KEY)?.find(match)
      ?.unread;
  }

  test("a pinned row adjusts the Pinned bucket", () => {
    const client = new QueryClient();
    seedIndex(client);

    const applied = adjustSectionUnreadCache(
      client,
      ASSISTANT_ID,
      makeConversation({
        conversationId: "c1",
        isPinned: true,
        groupId: "system:pinned",
        // Bucket precedence: pinned wins even for a row that also carries a
        // channel, mirroring the daemon's group-axis-first aggregation.
        originChannel: "slack",
      }),
      -1,
    );

    expect(applied).toBe(true);
    expect(unreadOf(client, (s) => s.kind === "pinned")).toBe(0);
    expect(unreadOf(client, (s) => s.kind === "channel")).toBe(1);
  });

  test("a grouped row adjusts its group's bucket", () => {
    const client = new QueryClient();
    seedIndex(client);

    adjustSectionUnreadCache(
      client,
      ASSISTANT_ID,
      makeConversation({ conversationId: "c1", groupId: "grp-1" }),
      -1,
    );

    expect(unreadOf(client, (s) => s.kind === "group")).toBe(1);
  });

  test("unattributed and vellum rows adjust the Chats bucket", () => {
    const client = new QueryClient();
    seedIndex(client);

    adjustSectionUnreadCache(
      client,
      ASSISTANT_ID,
      makeConversation({ conversationId: "c1" }),
      -1,
    );
    adjustSectionUnreadCache(
      client,
      ASSISTANT_ID,
      makeConversation({ conversationId: "c2", originChannel: "vellum" }),
      -1,
    );

    expect(unreadOf(client, (s) => s.kind === "chats")).toBe(1);
  });

  test("a channel row adjusts its channel's bucket", () => {
    const client = new QueryClient();
    seedIndex(client);

    adjustSectionUnreadCache(
      client,
      ASSISTANT_ID,
      makeConversation({ conversationId: "c1", originChannel: "slack" }),
      1,
    );

    expect(unreadOf(client, (s) => s.kind === "channel")).toBe(2);
  });

  test("a null index (assistant without the endpoint) is a no-op", () => {
    const client = new QueryClient();
    client.setQueryData<SidebarIndexSection[] | null>(INDEX_KEY, null);

    expect(
      adjustSectionUnreadCache(
        client,
        ASSISTANT_ID,
        makeConversation({ conversationId: "c1" }),
        -1,
      ),
    ).toBe(false);
    expect(client.getQueryData(INDEX_KEY)).toBeNull();
  });

  test("a bucket the index does not carry is left to the settle refetch", () => {
    const client = new QueryClient();
    client.setQueryData<SidebarIndexSection[] | null>(INDEX_KEY, [
      { kind: "chats", total: 5, unread: 3 },
    ]);

    expect(
      adjustSectionUnreadCache(
        client,
        ASSISTANT_ID,
        makeConversation({ conversationId: "c1", groupId: "grp-none" }),
        -1,
      ),
    ).toBe(false);
  });

  test("a delta and its inverse restore the original counts exactly", () => {
    const client = new QueryClient();
    seedIndex(client);
    const row = makeConversation({ conversationId: "c1", groupId: "grp-1" });

    adjustSectionUnreadCache(client, ASSISTANT_ID, row, -1);
    adjustSectionUnreadCache(client, ASSISTANT_ID, row, 1);

    expect(unreadOf(client, (s) => s.kind === "group")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applySurfacedConversation
// ---------------------------------------------------------------------------

describe("applySurfacedConversation", () => {
  test("a background-cache row reaches the foreground at its recency position", () => {
    const bg = makeConversation({
      conversationId: "bg1",
      conversationType: "background",
      lastMessageAt: 3000,
    });
    seedBackground(qc, [bg]);
    seedForeground(qc, [
      makeConversation({ conversationId: "newer", lastMessageAt: 5000 }),
      makeConversation({ conversationId: "older", lastMessageAt: 1000 }),
    ]);

    applySurfacedConversation(qc, ASSISTANT_ID, bg, 4242);

    // Recency position, not the top: the server writes only surfaced_at on
    // a bare surface, so nothing about the row's ordering moves.
    expect(getForeground(qc).map((c) => c.conversationId)).toEqual([
      "newer",
      "bg1",
      "older",
    ]);
    expect(getBackground(qc)[0].surfacedAt).toBe(4242);
    expect(getForeground(qc)[1].surfacedAt).toBe(4242);
  });

  test("a row already in the foreground is not duplicated", () => {
    const row = makeConversation({
      conversationId: "c1",
      conversationType: "scheduled",
    });
    seedForeground(qc, [row]);

    applySurfacedConversation(qc, ASSISTANT_ID, row, 4242);

    expect(getForeground(qc)).toHaveLength(1);
    expect(getForeground(qc)[0].surfacedAt).toBe(4242);
  });

  test("a write landing mid-request is not replayed backwards by the snapshot", () => {
    /* Mark-seen-on-open fires from the same render as the surface, so the
       seen patch lands while the POST is out. The captured snapshot still
       says unseen; applying it verbatim would resurrect the flag. */
    const stale = makeConversation({
      conversationId: "bg1",
      conversationType: "background",
      hasUnseenLatestAssistantMessage: true,
    });
    seedBackground(qc, [stale]);
    // The mark-seen patch lands before the surface response.
    seedBackground(qc, [{ ...stale, hasUnseenLatestAssistantMessage: false }]);
    seedForeground(qc, []);

    applySurfacedConversation(qc, ASSISTANT_ID, stale, 4242);

    expect(getForeground(qc)[0]).toMatchObject({
      conversationId: "bg1",
      hasUnseenLatestAssistantMessage: false,
      surfacedAt: 4242,
    });
  });

  test("the surfaced row joins its section cache through the membership pass", () => {
    const bg = makeConversation({
      conversationId: "bg1",
      conversationType: "background",
    });
    seedBackground(qc, [bg]);
    // Chats section contents cache: {groupId: system:all, channel: vellum}.
    const chatsKey = conversationListQueryKey(ASSISTANT_ID, {
      groupId: "system:all",
      originChannel: "vellum",
    });
    qc.setQueryData(chatsKey, listPage([]));

    applySurfacedConversation(qc, ASSISTANT_ID, bg, 4242);

    expect(
      qc
        .getQueryData<ConversationListPage>(chatsKey)
        ?.conversations.map((c) => c.conversationId),
    ).toEqual(["bg1"]);
  });
});
