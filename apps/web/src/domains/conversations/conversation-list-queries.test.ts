import { describe, expect, it } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import {
  appendGroupInCache,
  applyConversationPatch,
  chatContextQueryKey,
  conversationGroupsQueryKey,
  deleteGroupAndResetConversationsInCache,
  markConversationSeenInCache,
  patchConversationInCache,
  patchGroupInCache,
  prependConversationInCache,
  removeConversationFromCache,
  removeGroupFromCache,
  replaceOptimisticGroupInCache,
  resolveDraftKeyInCache,
} from "@/domains/conversations/conversation-list-queries.js";
import type {
  Conversation,
  ConversationGroup,
} from "@/domains/chat/api/conversations.js";
import type { ChatContext } from "@/domains/chat/api/assistant.js";

const ASSISTANT_ID = "ast-1";

function makeConversation(
  key: string,
  overrides?: Partial<Conversation>,
): Conversation {
  return { conversationKey: key, ...overrides } as Conversation;
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

function seedChatContext(
  qc: QueryClient,
  conversations: Conversation[],
): void {
  qc.setQueryData<ChatContext | null>(chatContextQueryKey(ASSISTANT_ID), {
    assistantId: ASSISTANT_ID,
    conversationKey: conversations[0]?.conversationKey ?? "",
    conversations,
  });
}

function getConversations(qc: QueryClient): Conversation[] {
  return (
    qc.getQueryData<ChatContext | null>(chatContextQueryKey(ASSISTANT_ID))
      ?.conversations ?? []
  );
}

function getGroups(qc: QueryClient): ConversationGroup[] {
  return (
    qc.getQueryData<ConversationGroup[]>(
      conversationGroupsQueryKey(ASSISTANT_ID),
    ) ?? []
  );
}

// ---------------------------------------------------------------------------
// applyConversationPatch
// ---------------------------------------------------------------------------

describe("applyConversationPatch", () => {
  it("patches the matching conversation by key", () => {
    const convs = [
      makeConversation("a", { title: "old" }),
      makeConversation("b", { title: "keep" }),
    ];
    const result = applyConversationPatch(convs, "a", { title: "new" });
    expect(result[0]!.title).toBe("new");
    expect(result[1]!.title).toBe("keep");
  });

  it("returns the same array reference when key does not match", () => {
    const convs = [makeConversation("a")];
    const result = applyConversationPatch(convs, "missing", { title: "x" });
    expect(result).toBe(convs);
  });
});

// ---------------------------------------------------------------------------
// Conversation cache helpers
// ---------------------------------------------------------------------------

describe("patchConversationInCache", () => {
  it("patches the matching conversation in the chat context cache", () => {
    const qc = new QueryClient();
    seedChatContext(qc, [
      makeConversation("a", { title: "old" }),
      makeConversation("b"),
    ]);
    patchConversationInCache(qc, ASSISTANT_ID, "a", { title: "new" });
    expect(getConversations(qc)[0]!.title).toBe("new");
  });

  it("is a no-op when no chat context is cached", () => {
    const qc = new QueryClient();
    patchConversationInCache(qc, ASSISTANT_ID, "a", { title: "x" });
    expect(
      qc.getQueryData<ChatContext | null>(chatContextQueryKey(ASSISTANT_ID)),
    ).toBeUndefined();
  });
});

describe("markConversationSeenInCache", () => {
  it("clears the unseen flag and stamps lastSeenAssistantMessageAt", () => {
    const qc = new QueryClient();
    seedChatContext(qc, [
      makeConversation("a", {
        hasUnseenLatestAssistantMessage: true,
        latestAssistantMessageAt: "2024-01-01T00:00:00Z",
      }),
    ]);
    markConversationSeenInCache(qc, ASSISTANT_ID, "a");
    expect(getConversations(qc)[0]!.hasUnseenLatestAssistantMessage).toBe(
      false,
    );
    expect(getConversations(qc)[0]!.lastSeenAssistantMessageAt).toBe(
      "2024-01-01T00:00:00Z",
    );
  });

  it("uses the explicit lastSeenAssistantMessageAt when provided", () => {
    const qc = new QueryClient();
    seedChatContext(qc, [
      makeConversation("a", { hasUnseenLatestAssistantMessage: true }),
    ]);
    markConversationSeenInCache(qc, ASSISTANT_ID, "a", "2024-06-01T00:00:00Z");
    expect(getConversations(qc)[0]!.lastSeenAssistantMessageAt).toBe(
      "2024-06-01T00:00:00Z",
    );
  });
});

describe("prependConversationInCache", () => {
  it("adds to the front of the list", () => {
    const qc = new QueryClient();
    seedChatContext(qc, [makeConversation("b")]);
    prependConversationInCache(qc, ASSISTANT_ID, makeConversation("a"));
    expect(getConversations(qc).map((c) => c.conversationKey)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("removeConversationFromCache", () => {
  it("removes the matching conversation", () => {
    const qc = new QueryClient();
    seedChatContext(qc, [makeConversation("a"), makeConversation("b")]);
    removeConversationFromCache(qc, ASSISTANT_ID, "a");
    expect(getConversations(qc).map((c) => c.conversationKey)).toEqual(["b"]);
  });
});

describe("resolveDraftKeyInCache", () => {
  it("remaps the conversation key and clears the draft flag", () => {
    const qc = new QueryClient();
    seedChatContext(qc, [makeConversation("draft-1", { draft: true })]);
    resolveDraftKeyInCache(qc, ASSISTANT_ID, "draft-1", "real-1");
    expect(getConversations(qc)[0]!.conversationKey).toBe("real-1");
    expect(getConversations(qc)[0]!.draft).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group cache helpers
// ---------------------------------------------------------------------------

describe("appendGroupInCache", () => {
  it("auto-computes sortPosition from the current group count", () => {
    const qc = new QueryClient();
    qc.setQueryData<ConversationGroup[]>(
      conversationGroupsQueryKey(ASSISTANT_ID),
      [makeGroup("g1", "First", { sortPosition: 0 })],
    );
    appendGroupInCache(
      qc,
      ASSISTANT_ID,
      makeGroup("g2", "Second", { sortPosition: 0 }),
    );
    const groups = getGroups(qc);
    expect(groups).toHaveLength(2);
    expect(groups[1]!.sortPosition).toBe(1);
  });
});

describe("patchGroupInCache", () => {
  it("patches the matching group", () => {
    const qc = new QueryClient();
    qc.setQueryData<ConversationGroup[]>(
      conversationGroupsQueryKey(ASSISTANT_ID),
      [makeGroup("g1", "Old")],
    );
    patchGroupInCache(qc, ASSISTANT_ID, "g1", { name: "New" });
    expect(getGroups(qc)[0]!.name).toBe("New");
  });
});

describe("replaceOptimisticGroupInCache", () => {
  it("swaps the optimistic group with the real one", () => {
    const qc = new QueryClient();
    qc.setQueryData<ConversationGroup[]>(
      conversationGroupsQueryKey(ASSISTANT_ID),
      [makeGroup("opt-1", "Temp")],
    );
    const real = makeGroup("real-1", "Real");
    replaceOptimisticGroupInCache(qc, ASSISTANT_ID, "opt-1", real);
    expect(getGroups(qc)[0]).toEqual(real);
  });
});

describe("removeGroupFromCache", () => {
  it("removes the matching group", () => {
    const qc = new QueryClient();
    qc.setQueryData<ConversationGroup[]>(
      conversationGroupsQueryKey(ASSISTANT_ID),
      [makeGroup("g1", "A"), makeGroup("g2", "B")],
    );
    removeGroupFromCache(qc, ASSISTANT_ID, "g1");
    expect(getGroups(qc).map((g) => g.id)).toEqual(["g2"]);
  });
});

describe("deleteGroupAndResetConversationsInCache", () => {
  it("removes the group and clears groupId on affected conversations", () => {
    const qc = new QueryClient();
    seedChatContext(qc, [
      makeConversation("a", { groupId: "g1" }),
      makeConversation("b", { groupId: "g2" }),
    ]);
    qc.setQueryData<ConversationGroup[]>(
      conversationGroupsQueryKey(ASSISTANT_ID),
      [makeGroup("g1", "G1"), makeGroup("g2", "G2")],
    );
    deleteGroupAndResetConversationsInCache(qc, ASSISTANT_ID, "g1");
    expect(getGroups(qc).map((g) => g.id)).toEqual(["g2"]);
    expect(getConversations(qc)[0]!.groupId).toBeUndefined();
    expect(getConversations(qc)[1]!.groupId).toBe("g2");
  });
});
