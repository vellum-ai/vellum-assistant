import { describe, expect, it } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import {
  appendGroup,
  deleteGroupAndResetConversations,
  markConversationSeenLocal,
  patchGroup,
  prependConversation,
  removeConversation,
  removeGroup,
  replaceOptimisticGroup,
  resolveDraftKey,
} from "@/utils/conversation-cache-mutations";
import {
  backgroundConversationsQueryKey,
  conversationGroupsQueryKey,
  conversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import { patchConversation } from "@/utils/conversation-cache";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import type { GroupsGetResponse } from "@/generated/daemon/types.gen";
import { getConversations as getMergedConversations } from "@/utils/conversation-cache";

const ASSISTANT_ID = "ast-1";

function makeConversation(
  conversationId: string,
  overrides?: Partial<Conversation>,
): Conversation {
  return { conversationId, ...overrides } as Conversation;
}

function makeGroup(
  id: string,
  name: string,
  overrides?: Partial<ConversationGroup>,
): ConversationGroup {
  return {
    id,
    name,
    sortPosition: 0,
    isSystemGroup: false,
    ...overrides,
  };
}

function seedConversations(
  qc: QueryClient,
  conversations: Conversation[],
): void {
  qc.setQueryData<Conversation[]>(
    conversationsQueryKey(ASSISTANT_ID),
    conversations,
  );
}

function getConversations(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID)) ?? []
  );
}

function seedBackgroundConversations(
  qc: QueryClient,
  conversations: Conversation[],
): void {
  qc.setQueryData<Conversation[]>(
    backgroundConversationsQueryKey(ASSISTANT_ID),
    conversations,
  );
}

function getBackgroundConversations(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<Conversation[]>(
      backgroundConversationsQueryKey(ASSISTANT_ID),
    ) ?? []
  );
}

function seedScheduledConversations(
  qc: QueryClient,
  conversations: Conversation[],
): void {
  qc.setQueryData<Conversation[]>(
    scheduledConversationsQueryKey(ASSISTANT_ID),
    conversations,
  );
}

function getScheduledConversations(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<Conversation[]>(
      scheduledConversationsQueryKey(ASSISTANT_ID),
    ) ?? []
  );
}

function getGroups(qc: QueryClient): ConversationGroup[] {
  return (
    qc.getQueryData<GroupsGetResponse>(
      conversationGroupsQueryKey(ASSISTANT_ID),
    )?.groups ?? []
  );
}

function seedGroups(qc: QueryClient, groups: ConversationGroup[]): void {
  qc.setQueryData<GroupsGetResponse>(
    conversationGroupsQueryKey(ASSISTANT_ID),
    { groups },
  );
}

// ---------------------------------------------------------------------------
// Conversation cache helpers
// ---------------------------------------------------------------------------

describe("patchConversation", () => {
  it("patches the matching conversation in the cache", () => {
    const qc = new QueryClient();
    seedConversations(qc, [
      makeConversation("a", { title: "old" }),
      makeConversation("b"),
    ]);
    patchConversation(qc, ASSISTANT_ID, "a", { title: "new" });
    expect(getConversations(qc)[0]!.title).toBe("new");
  });

  it("is a no-op when no conversations are cached", () => {
    const qc = new QueryClient();
    patchConversation(qc, ASSISTANT_ID, "a", { title: "x" });
    expect(
      qc.getQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID)),
    ).toBeUndefined();
  });
});

describe("foreground/background/scheduled cache split", () => {
  it("patches a row that lives only in the background cache", () => {
    /**
     * A mutation keyed by conversationId must reach background rows even
     * though they live in a separate cache from the foreground list.
     */

    // GIVEN a foreground list and a separate background list
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("fg")]);
    seedBackgroundConversations(qc, [
      makeConversation("bg", { title: "old" }),
    ]);

    // WHEN we patch a conversation that only exists in the background cache
    patchConversation(qc, ASSISTANT_ID, "bg", { title: "new" });

    // THEN the background row is updated
    expect(getBackgroundConversations(qc)[0]!.title).toBe("new");
    // AND the foreground list is left untouched
    expect(getConversations(qc)).toHaveLength(1);
    expect(getConversations(qc)[0]!.conversationId).toBe("fg");
  });

  it("removes a row from whichever cache holds it", () => {
    /**
     * Deleting a conversation by id should drop it regardless of which
     * cache it belongs to.
     */

    // GIVEN one foreground and one background conversation
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("fg")]);
    seedBackgroundConversations(qc, [makeConversation("bg")]);

    // WHEN we remove the background conversation
    removeConversation(qc, ASSISTANT_ID, "bg");

    // THEN it is gone from the background cache
    expect(getBackgroundConversations(qc)).toHaveLength(0);
    // AND the foreground conversation remains
    expect(getConversations(qc).map((c) => c.conversationId)).toEqual(["fg"]);
  });

  it("merges both caches and de-duplicates with foreground winning", () => {
    /**
     * Consumers that need every conversation read the merged view, which
     * unions the two caches and prefers the foreground copy on collision.
     */

    // GIVEN the same id present in both caches with different titles
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("shared", { title: "fg" })]);
    seedBackgroundConversations(qc, [
      makeConversation("shared", { title: "bg" }),
      makeConversation("bg-only"),
    ]);

    // WHEN we read the merged conversation view
    const merged = getMergedConversations(qc, ASSISTANT_ID);

    // THEN the shared id appears once, keeping the foreground copy
    expect(merged.map((c) => c.conversationId)).toEqual(["shared", "bg-only"]);
    expect(merged[0]!.title).toBe("fg");
  });

  it("patches a row that lives only in the scheduled cache", () => {
    /**
     * The scheduled list is its own cache, independent of background; a
     * mutation keyed by conversationId must still reach it.
     */

    // GIVEN a row that only exists in the scheduled cache
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("fg")]);
    seedScheduledConversations(qc, [
      makeConversation("sched", { title: "old" }),
    ]);

    // WHEN we patch that scheduled-only conversation
    patchConversation(qc, ASSISTANT_ID, "sched", { title: "new" });

    // THEN the scheduled row is updated
    expect(getScheduledConversations(qc)[0]!.title).toBe("new");
    // AND the foreground list is left untouched
    expect(getConversations(qc).map((c) => c.conversationId)).toEqual(["fg"]);
  });

  it("removes a scheduled row without touching the other caches", () => {
    /**
     * Deleting by id drops the row from the scheduled cache while leaving
     * the foreground and background caches intact.
     */

    // GIVEN one row in each of the three caches
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("fg")]);
    seedBackgroundConversations(qc, [makeConversation("bg")]);
    seedScheduledConversations(qc, [makeConversation("sched")]);

    // WHEN we remove the scheduled conversation
    removeConversation(qc, ASSISTANT_ID, "sched");

    // THEN it is gone from the scheduled cache
    expect(getScheduledConversations(qc)).toHaveLength(0);
    // AND the foreground and background caches are untouched
    expect(getConversations(qc).map((c) => c.conversationId)).toEqual(["fg"]);
    expect(getBackgroundConversations(qc).map((c) => c.conversationId)).toEqual(
      ["bg"],
    );
  });

  it("merges all three caches with foreground winning on collision", () => {
    /**
     * Consumers that need every conversation read the merged view, which
     * unions the foreground, background, and scheduled caches and prefers
     * the foreground copy when the same id appears more than once.
     */

    // GIVEN the same id in all three caches plus a scheduled-only row
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("shared", { title: "fg" })]);
    seedBackgroundConversations(qc, [
      makeConversation("shared", { title: "bg" }),
      makeConversation("bg-only"),
    ]);
    seedScheduledConversations(qc, [
      makeConversation("shared", { title: "sched" }),
      makeConversation("sched-only"),
    ]);

    // WHEN we read the merged conversation view
    const merged = getMergedConversations(qc, ASSISTANT_ID);

    // THEN the shared id appears once (foreground copy) alongside both
    // cache-only rows
    expect(merged.map((c) => c.conversationId)).toEqual([
      "shared",
      "bg-only",
      "sched-only",
    ]);
    expect(merged[0]!.title).toBe("fg");
  });
});

describe("markConversationSeenLocal", () => {
  it("clears the unseen flag and stamps lastSeenAssistantMessageAt", () => {
    const qc = new QueryClient();
    seedConversations(qc, [
      makeConversation("a", {
        hasUnseenLatestAssistantMessage: true,
        latestAssistantMessageAt: 1704067200000,
      }),
    ]);
    markConversationSeenLocal(qc, ASSISTANT_ID, "a");
    expect(getConversations(qc)[0]!.hasUnseenLatestAssistantMessage).toBe(
      false,
    );
    expect(getConversations(qc)[0]!.lastSeenAssistantMessageAt).toBe(
      1704067200000,
    );
  });

  it("uses the explicit lastSeenAssistantMessageAt when provided", () => {
    const qc = new QueryClient();
    seedConversations(qc, [
      makeConversation("a", { hasUnseenLatestAssistantMessage: true }),
    ]);
    markConversationSeenLocal(qc, ASSISTANT_ID, "a", 1717200000000);
    expect(getConversations(qc)[0]!.lastSeenAssistantMessageAt).toBe(
      1717200000000,
    );
  });
});

describe("prependConversation", () => {
  it("adds to the front of the list", () => {
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("b")]);
    prependConversation(qc, ASSISTANT_ID, makeConversation("a"));
    expect(getConversations(qc).map((c) => c.conversationId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("removeConversation", () => {
  it("removes the matching conversation", () => {
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("a"), makeConversation("b")]);
    removeConversation(qc, ASSISTANT_ID, "a");
    expect(getConversations(qc).map((c) => c.conversationId)).toEqual(["b"]);
  });
});

describe("resolveDraftKey", () => {
  it("remaps the conversation key and clears the draft flag", () => {
    const qc = new QueryClient();
    seedConversations(qc, [makeConversation("draft-1", { draft: true })]);
    resolveDraftKey(qc, ASSISTANT_ID, "draft-1", "real-1");
    expect(getConversations(qc)[0]!.conversationId).toBe("real-1");
    expect(getConversations(qc)[0]!.draft).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group cache helpers
// ---------------------------------------------------------------------------

describe("appendGroup", () => {
  it("auto-computes sortPosition from the current group count when undefined", () => {
    const qc = new QueryClient();
    seedGroups(qc, [makeGroup("g1", "First", { sortPosition: 0 })]);
    const group = makeGroup("g2", "Second");
    (group as Record<string, unknown>).sortPosition = undefined;
    appendGroup(qc, ASSISTANT_ID, group);
    const groups = getGroups(qc);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.sortPosition).toBe(1);
  });

  it("preserves sortPosition of 0", () => {
    const qc = new QueryClient();
    seedGroups(qc, [makeGroup("g1", "First", { sortPosition: 0 })]);
    appendGroup(
      qc,
      ASSISTANT_ID,
      makeGroup("g2", "Second", { sortPosition: 0 }),
    );
    const groups = getGroups(qc);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.sortPosition).toBe(0);
  });
});

describe("patchGroup", () => {
  it("patches the matching group", () => {
    const qc = new QueryClient();
    seedGroups(qc, [makeGroup("g1", "Old")]);
    patchGroup(qc, ASSISTANT_ID, "g1", { name: "New" });
    expect(getGroups(qc)[0]!.name).toBe("New");
  });
});

describe("replaceOptimisticGroup", () => {
  it("swaps the optimistic group with the real one", () => {
    const qc = new QueryClient();
    seedGroups(qc, [makeGroup("opt-1", "Temp")]);
    const real = makeGroup("real-1", "Real");
    replaceOptimisticGroup(qc, ASSISTANT_ID, "opt-1", real);
    expect(getGroups(qc)[0]).toEqual(real);
  });
});

describe("removeGroup", () => {
  it("removes the matching group", () => {
    const qc = new QueryClient();
    seedGroups(qc, [makeGroup("g1", "A"), makeGroup("g2", "B")]);
    removeGroup(qc, ASSISTANT_ID, "g1");
    expect(getGroups(qc).map((g) => g.id)).toEqual(["g2"]);
  });
});

describe("deleteGroupAndResetConversations", () => {
  it("removes the group and clears groupId on affected conversations", () => {
    const qc = new QueryClient();
    seedConversations(qc, [
      makeConversation("a", { groupId: "g1" }),
      makeConversation("b", { groupId: "g2" }),
    ]);
    seedGroups(qc, [makeGroup("g1", "G1"), makeGroup("g2", "G2")]);
    deleteGroupAndResetConversations(qc, ASSISTANT_ID, "g1");
    expect(getGroups(qc).map((g) => g.id)).toEqual(["g2"]);
    expect(getConversations(qc)[0]!.groupId).toBeUndefined();
    expect(getConversations(qc)[1]!.groupId).toBe("g2");
  });
});
