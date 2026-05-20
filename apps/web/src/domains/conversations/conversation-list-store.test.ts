import { afterEach, describe, it, expect } from "bun:test";

import { useConversationListStore } from "@/domains/conversations/conversation-list-store.js";
import type { Conversation, ConversationGroup } from "@/domains/chat/api/conversations.js";

function makeConversation(key: string, overrides?: Partial<Conversation>): Conversation {
  return { conversationKey: key, ...overrides } as Conversation;
}

function makeGroup(id: string, name: string, overrides?: Partial<ConversationGroup>): ConversationGroup {
  return { id, name, sortPosition: 0, isSystemGroup: false, ...overrides };
}

function getState() {
  return useConversationListStore.getState();
}

afterEach(() => {
  getState().reset();
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

describe("useConversationListStore", () => {
  describe("setConversations", () => {
    it("replaces the conversation list", () => {
      const convs = [makeConversation("a"), makeConversation("b")];
      getState().setConversations(convs);
      expect(getState().conversations).toBe(convs);
    });
  });

  describe("patchConversation", () => {
    it("patches the matching conversation", () => {
      const convs = [makeConversation("a", { title: "old" }), makeConversation("b")];
      getState().setConversations(convs);
      getState().patchConversation("a", { title: "new" });
      expect(getState().conversations[0]!.title).toBe("new");
      expect(getState().conversations[1]).toBe(convs[1]!);
    });

    it("returns the same conversations array when key is not found", () => {
      const convs = [makeConversation("a")];
      getState().setConversations(convs);
      getState().patchConversation("missing", { title: "x" });
      expect(getState().conversations).toBe(convs);
    });
  });

  describe("markConversationSeen", () => {
    it("clears the unseen flag and sets lastSeenAssistantMessageAt", () => {
      getState().setConversations([
        makeConversation("a", {
          hasUnseenLatestAssistantMessage: true,
          latestAssistantMessageAt: "2024-01-01T00:00:00Z",
        }),
      ]);
      getState().markConversationSeen("a");
      expect(getState().conversations[0]!.hasUnseenLatestAssistantMessage).toBe(false);
      expect(getState().conversations[0]!.lastSeenAssistantMessageAt).toBe("2024-01-01T00:00:00Z");
    });

    it("uses explicit lastSeenAssistantMessageAt when provided", () => {
      getState().setConversations([
        makeConversation("a", { hasUnseenLatestAssistantMessage: true }),
      ]);
      getState().markConversationSeen("a", "2024-06-01T00:00:00Z");
      expect(getState().conversations[0]!.lastSeenAssistantMessageAt).toBe("2024-06-01T00:00:00Z");
    });
  });

  describe("prependConversation", () => {
    it("adds to front of list", () => {
      getState().setConversations([makeConversation("b")]);
      getState().prependConversation(makeConversation("a"));
      expect(getState().conversations).toHaveLength(2);
      expect(getState().conversations[0]!.conversationKey).toBe("a");
    });
  });

  describe("removeConversation", () => {
    it("removes the matching conversation", () => {
      getState().setConversations([makeConversation("a"), makeConversation("b")]);
      getState().removeConversation("a");
      expect(getState().conversations).toHaveLength(1);
      expect(getState().conversations[0]!.conversationKey).toBe("b");
    });
  });

  describe("resolveDraftKey", () => {
    it("remaps the conversation key and clears draft flag", () => {
      getState().setConversations([makeConversation("draft-1", { draft: true })]);
      getState().resolveDraftKey("draft-1", "real-1");
      expect(getState().conversations[0]!.conversationKey).toBe("real-1");
      expect(getState().conversations[0]!.draft).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Conversation groups
  // ---------------------------------------------------------------------------

  describe("setGroups", () => {
    it("replaces the groups list", () => {
      const groups = [makeGroup("g1", "Group 1")];
      getState().setGroups(groups);
      expect(getState().conversationGroups).toBe(groups);
    });
  });

  describe("appendGroup", () => {
    it("adds to end of list", () => {
      getState().setGroups([makeGroup("g1", "First")]);
      getState().appendGroup(makeGroup("g2", "Second"));
      expect(getState().conversationGroups).toHaveLength(2);
      expect(getState().conversationGroups[1]!.name).toBe("Second");
    });

    it("auto-computes sortPosition from current group count when 0", () => {
      getState().setGroups([
        makeGroup("g1", "First", { sortPosition: 0 }),
        makeGroup("g2", "Second", { sortPosition: 1 }),
      ]);
      getState().appendGroup(makeGroup("g3", "Third", { sortPosition: 0 }));
      expect(getState().conversationGroups).toHaveLength(3);
      expect(getState().conversationGroups[2]!.sortPosition).toBe(2);
    });
  });

  describe("patchGroup", () => {
    it("patches the matching group", () => {
      getState().setGroups([makeGroup("g1", "Old")]);
      getState().patchGroup("g1", { name: "New" });
      expect(getState().conversationGroups[0]!.name).toBe("New");
    });

    it("returns same array when group not found", () => {
      const groups = [makeGroup("g1", "Name")];
      getState().setGroups(groups);
      getState().patchGroup("missing", { name: "X" });
      expect(getState().conversationGroups).toBe(groups);
    });
  });

  describe("replaceOptimisticGroup", () => {
    it("swaps the optimistic group with the real one", () => {
      getState().setGroups([makeGroup("opt-1", "Temp")]);
      const real = makeGroup("real-1", "Real Group");
      getState().replaceOptimisticGroup("opt-1", real);
      expect(getState().conversationGroups[0]!).toBe(real);
    });
  });

  describe("removeGroup", () => {
    it("removes the matching group", () => {
      getState().setGroups([makeGroup("g1", "A"), makeGroup("g2", "B")]);
      getState().removeGroup("g1");
      expect(getState().conversationGroups).toHaveLength(1);
      expect(getState().conversationGroups[0]!.id).toBe("g2");
    });
  });

  describe("deleteGroupAndResetConversations", () => {
    it("removes the group and clears groupId on affected conversations", () => {
      getState().setConversations([
        makeConversation("a", { groupId: "g1" }),
        makeConversation("b", { groupId: "g2" }),
      ]);
      getState().setGroups([makeGroup("g1", "G1"), makeGroup("g2", "G2")]);
      getState().deleteGroupAndResetConversations("g1");
      expect(getState().conversationGroups).toHaveLength(1);
      expect(getState().conversations[0]!.groupId).toBeUndefined();
      expect(getState().conversations[1]!.groupId).toBe("g2");
    });
  });

  // ---------------------------------------------------------------------------
  // Active / editing key
  // ---------------------------------------------------------------------------

  describe("setActiveKey", () => {
    it("sets the active conversation key", () => {
      getState().setActiveKey("abc");
      expect(getState().activeConversationKey).toBe("abc");
    });
  });

  describe("setEditingKey", () => {
    it("sets the editing conversation key", () => {
      getState().setEditingKey("edit-1");
      expect(getState().editingConversationKey).toBe("edit-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Processing keys
  // ---------------------------------------------------------------------------

  describe("addProcessingKey", () => {
    it("adds a key to the set", () => {
      getState().addProcessingKey("k1");
      expect(getState().processingKeys.has("k1")).toBe(true);
    });

    it("returns the same Set reference when key already present", () => {
      getState().addProcessingKey("k1");
      const before = getState().processingKeys;
      getState().addProcessingKey("k1");
      expect(getState().processingKeys).toBe(before);
    });
  });

  describe("removeProcessingKey", () => {
    it("removes a key from the set", () => {
      getState().addProcessingKey("k1");
      getState().addProcessingKey("k2");
      getState().removeProcessingKey("k1");
      expect(getState().processingKeys.has("k1")).toBe(false);
      expect(getState().processingKeys.has("k2")).toBe(true);
    });

    it("returns the same Set reference when key not present", () => {
      getState().addProcessingKey("k1");
      const before = getState().processingKeys;
      getState().removeProcessingKey("missing");
      expect(getState().processingKeys).toBe(before);
    });
  });

  describe("removeMultipleProcessingKeys", () => {
    it("removes multiple keys at once", () => {
      getState().addProcessingKey("a");
      getState().addProcessingKey("b");
      getState().addProcessingKey("c");
      getState().removeMultipleProcessingKeys(["a", "c"]);
      expect(getState().processingKeys.size).toBe(1);
      expect(getState().processingKeys.has("b")).toBe(true);
    });

    it("returns same Set when no keys match", () => {
      getState().addProcessingKey("a");
      const before = getState().processingKeys;
      getState().removeMultipleProcessingKeys(["x", "y"]);
      expect(getState().processingKeys).toBe(before);
    });
  });

  describe("transferProcessingKey", () => {
    it("replaces oldKey with newKey", () => {
      getState().addProcessingKey("old");
      getState().transferProcessingKey("old", "new");
      expect(getState().processingKeys.has("old")).toBe(false);
      expect(getState().processingKeys.has("new")).toBe(true);
    });

    it("is a no-op when oldKey not present", () => {
      getState().addProcessingKey("other");
      const before = getState().processingKeys;
      getState().transferProcessingKey("missing", "new");
      expect(getState().processingKeys).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Attention keys
  // ---------------------------------------------------------------------------

  describe("addAttentionKey", () => {
    it("adds a key", () => {
      getState().addAttentionKey("a1");
      expect(getState().attentionKeys.has("a1")).toBe(true);
    });
  });

  describe("removeAttentionKey", () => {
    it("removes a key", () => {
      getState().addAttentionKey("a1");
      getState().removeAttentionKey("a1");
      expect(getState().attentionKeys.has("a1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Compound actions
  // ---------------------------------------------------------------------------

  describe("graduateProcessingKey", () => {
    it("removes from processing and adds to attention when interaction pending", () => {
      getState().addProcessingKey("k1");
      getState().graduateProcessingKey("k1", true);
      expect(getState().processingKeys.has("k1")).toBe(false);
      expect(getState().attentionKeys.has("k1")).toBe(true);
    });

    it("removes from processing without adding to attention when no interaction pending", () => {
      getState().addProcessingKey("k1");
      getState().graduateProcessingKey("k1", false);
      expect(getState().processingKeys.has("k1")).toBe(false);
      expect(getState().attentionKeys.has("k1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  it("reset clears all state", () => {
    getState().setConversations([makeConversation("a")]);
    getState().setActiveKey("a");
    getState().addProcessingKey("k1");
    getState().addAttentionKey("a1");
    getState().reset();
    expect(getState().conversations).toEqual([]);
    expect(getState().activeConversationKey).toBeNull();
    expect(getState().processingKeys.size).toBe(0);
    expect(getState().attentionKeys.size).toBe(0);
  });
});
