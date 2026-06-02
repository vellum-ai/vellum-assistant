import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import type { GroupsGetResponse } from "@/generated/daemon/types.gen";
import {
  conversationsQueryKey,
  backgroundConversationsQueryKey,
  scheduledConversationsQueryKey,
  archivedConversationsQueryKey,
  conversationGroupsQueryKey,
} from "@/lib/sync/query-tags";

import {
  markConversationSeenLocal,
  prependConversation,
  removeConversation,
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
  qc.setQueryData(conversationsQueryKey(ASSISTANT_ID), conversations);
}

function seedBackground(qc: QueryClient, conversations: Conversation[]) {
  qc.setQueryData(backgroundConversationsQueryKey(ASSISTANT_ID), conversations);
}

function seedScheduled(qc: QueryClient, conversations: Conversation[]) {
  qc.setQueryData(scheduledConversationsQueryKey(ASSISTANT_ID), conversations);
}

function seedArchived(qc: QueryClient, conversations: Conversation[]) {
  qc.setQueryData(archivedConversationsQueryKey(ASSISTANT_ID), conversations);
}

function seedGroups(qc: QueryClient, groups: ConversationGroup[]) {
  qc.setQueryData<GroupsGetResponse>(
    conversationGroupsQueryKey(ASSISTANT_ID),
    { groups },
  );
}

function getForeground(qc: QueryClient): Conversation[] {
  return qc.getQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID)) ?? [];
}

function getBackground(qc: QueryClient): Conversation[] {
  return qc.getQueryData<Conversation[]>(backgroundConversationsQueryKey(ASSISTANT_ID)) ?? [];
}

function getScheduled(qc: QueryClient): Conversation[] {
  return qc.getQueryData<Conversation[]>(scheduledConversationsQueryKey(ASSISTANT_ID)) ?? [];
}

function getArchived(qc: QueryClient): Conversation[] {
  return qc.getQueryData<Conversation[]>(archivedConversationsQueryKey(ASSISTANT_ID)) ?? [];
}

function getGroups(qc: QueryClient): ConversationGroup[] {
  return (
    qc.getQueryData<GroupsGetResponse>(conversationGroupsQueryKey(ASSISTANT_ID))?.groups ?? []
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

    prependConversation(qc, ASSISTANT_ID, makeConversation({ conversationId: "c1" }));

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
      makeConversation({ conversationId: "bg1", conversationType: "background" }),
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
    seedArchived(qc, [
      makeConversation({ conversationId: "a1" }),
    ]);

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

    appendGroup(qc, ASSISTANT_ID, makeGroup({ id: "g2", name: "Second", sortPosition: 0 }));

    expect(getGroups(qc)[1].sortPosition).toBe(0);
  });

  test("preserves explicit non-zero sortPosition", () => {
    seedGroups(qc, []);

    appendGroup(qc, ASSISTANT_ID, makeGroup({ id: "g1", name: "First", sortPosition: 5 }));

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

    const serverGroup = makeGroup({ id: "real-1", name: "Server Name", sortPosition: 3 });
    replaceOptimisticGroup(qc, ASSISTANT_ID, "optimistic-1", serverGroup);

    const groups = getGroups(qc);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("real-1");
    expect(groups[0].name).toBe("Server Name");
  });

  test("no-op when optimistic id not found", () => {
    seedGroups(qc, [makeGroup({ id: "g1", name: "Existing" })]);

    replaceOptimisticGroup(qc, ASSISTANT_ID, "nonexistent", makeGroup({ id: "g2", name: "New" }));

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
      makeConversation({ conversationId: "bg1", groupId: "g1", conversationType: "background" }),
    ]);
    seedScheduled(qc, [
      makeConversation({ conversationId: "s1", groupId: "g1", conversationType: "scheduled" }),
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
    const original = [makeConversation({ conversationId: "c1", groupId: "other" })];
    seedForeground(qc, original);

    deleteGroupAndResetConversations(qc, ASSISTANT_ID, "g1");

    expect(getForeground(qc)).toBe(original);
  });
});
