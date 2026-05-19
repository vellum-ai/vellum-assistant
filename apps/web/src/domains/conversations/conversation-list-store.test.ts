import { describe, it, expect } from "bun:test";

import type { Conversation, ConversationGroup } from "@/domains/chat/lib/api.js";
import {
  type ConversationListState,
  INITIAL_CONVERSATION_LIST_STATE,
  conversationListReducer,
} from "@/domains/conversations/conversation-list-store.js";

function makeConversation(key: string, overrides?: Partial<Conversation>): Conversation {
  return { conversationKey: key, ...overrides } as Conversation;
}

function makeGroup(id: string, name: string, overrides?: Partial<ConversationGroup>): ConversationGroup {
  return { id, name, sortPosition: 0, isSystemGroup: false, ...overrides };
}

function stateWith(overrides: Partial<ConversationListState>): ConversationListState {
  return { ...INITIAL_CONVERSATION_LIST_STATE, ...overrides };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

describe("conversationListReducer", () => {
  describe("SET_CONVERSATIONS", () => {
    it("replaces the conversation list", () => {
      const convs = [makeConversation("a"), makeConversation("b")];
      const next = conversationListReducer(INITIAL_CONVERSATION_LIST_STATE, {
        type: "SET_CONVERSATIONS",
        conversations: convs,
      });
      expect(next.conversations).toBe(convs);
    });
  });

  describe("PATCH_CONVERSATION", () => {
    it("patches the matching conversation", () => {
      const state = stateWith({
        conversations: [makeConversation("a", { title: "old" }), makeConversation("b")],
      });
      const next = conversationListReducer(state, {
        type: "PATCH_CONVERSATION",
        key: "a",
        patch: { title: "new" },
      });
      expect(next.conversations[0]!.title).toBe("new");
      expect(next.conversations[1]).toBe(state.conversations[1]!);
    });

    it("returns the same conversations array when key is not found", () => {
      const state = stateWith({
        conversations: [makeConversation("a")],
      });
      const next = conversationListReducer(state, {
        type: "PATCH_CONVERSATION",
        key: "missing",
        patch: { title: "x" },
      });
      expect(next.conversations).toBe(state.conversations);
    });
  });

  describe("MARK_CONVERSATION_SEEN", () => {
    it("clears the unseen flag and sets lastSeenAssistantMessageAt", () => {
      const state = stateWith({
        conversations: [
          makeConversation("a", {
            hasUnseenLatestAssistantMessage: true,
            latestAssistantMessageAt: "2024-01-01T00:00:00Z",
          }),
        ],
      });
      const next = conversationListReducer(state, {
        type: "MARK_CONVERSATION_SEEN",
        key: "a",
      });
      expect(next.conversations[0]!.hasUnseenLatestAssistantMessage).toBe(false);
      expect(next.conversations[0]!.lastSeenAssistantMessageAt).toBe("2024-01-01T00:00:00Z");
    });

    it("uses explicit lastSeenAssistantMessageAt when provided", () => {
      const state = stateWith({
        conversations: [
          makeConversation("a", { hasUnseenLatestAssistantMessage: true }),
        ],
      });
      const next = conversationListReducer(state, {
        type: "MARK_CONVERSATION_SEEN",
        key: "a",
        lastSeenAssistantMessageAt: "2024-06-01T00:00:00Z",
      });
      expect(next.conversations[0]!.lastSeenAssistantMessageAt).toBe("2024-06-01T00:00:00Z");
    });
  });

  describe("PREPEND_CONVERSATION", () => {
    it("adds to front of list", () => {
      const state = stateWith({ conversations: [makeConversation("b")] });
      const next = conversationListReducer(state, {
        type: "PREPEND_CONVERSATION",
        conversation: makeConversation("a"),
      });
      expect(next.conversations).toHaveLength(2);
      expect(next.conversations[0]!.conversationKey).toBe("a");
    });
  });

  describe("REMOVE_CONVERSATION", () => {
    it("removes the matching conversation", () => {
      const state = stateWith({
        conversations: [makeConversation("a"), makeConversation("b")],
      });
      const next = conversationListReducer(state, {
        type: "REMOVE_CONVERSATION",
        key: "a",
      });
      expect(next.conversations).toHaveLength(1);
      expect(next.conversations[0]!.conversationKey).toBe("b");
    });
  });

  describe("RESOLVE_DRAFT_KEY", () => {
    it("remaps the conversation key and clears draft flag", () => {
      const state = stateWith({
        conversations: [makeConversation("draft-1", { draft: true })],
      });
      const next = conversationListReducer(state, {
        type: "RESOLVE_DRAFT_KEY",
        oldKey: "draft-1",
        newKey: "real-1",
      });
      expect(next.conversations[0]!.conversationKey).toBe("real-1");
      expect(next.conversations[0]!.draft).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Conversation groups
  // ---------------------------------------------------------------------------

  describe("SET_GROUPS", () => {
    it("replaces the groups list", () => {
      const groups = [makeGroup("g1", "Group 1")];
      const next = conversationListReducer(INITIAL_CONVERSATION_LIST_STATE, {
        type: "SET_GROUPS",
        groups,
      });
      expect(next.conversationGroups).toBe(groups);
    });
  });

  describe("APPEND_GROUP", () => {
    it("adds to end of list", () => {
      const state = stateWith({
        conversationGroups: [makeGroup("g1", "First")],
      });
      const next = conversationListReducer(state, {
        type: "APPEND_GROUP",
        group: makeGroup("g2", "Second"),
      });
      expect(next.conversationGroups).toHaveLength(2);
      expect(next.conversationGroups[1]!.name).toBe("Second");
    });

    it("auto-computes sortPosition from current group count when 0", () => {
      const state = stateWith({
        conversationGroups: [
          makeGroup("g1", "First", { sortPosition: 0 }),
          makeGroup("g2", "Second", { sortPosition: 1 }),
        ],
      });
      const next = conversationListReducer(state, {
        type: "APPEND_GROUP",
        group: makeGroup("g3", "Third", { sortPosition: 0 }),
      });
      expect(next.conversationGroups).toHaveLength(3);
      expect(next.conversationGroups[2]!.sortPosition).toBe(2);
    });
  });

  describe("PATCH_GROUP", () => {
    it("patches the matching group", () => {
      const state = stateWith({
        conversationGroups: [makeGroup("g1", "Old")],
      });
      const next = conversationListReducer(state, {
        type: "PATCH_GROUP",
        groupId: "g1",
        patch: { name: "New" },
      });
      expect(next.conversationGroups[0]!.name).toBe("New");
    });

    it("returns same array when group not found", () => {
      const state = stateWith({
        conversationGroups: [makeGroup("g1", "Name")],
      });
      const next = conversationListReducer(state, {
        type: "PATCH_GROUP",
        groupId: "missing",
        patch: { name: "X" },
      });
      expect(next.conversationGroups).toBe(state.conversationGroups);
    });
  });

  describe("REPLACE_OPTIMISTIC_GROUP", () => {
    it("swaps the optimistic group with the real one", () => {
      const state = stateWith({
        conversationGroups: [makeGroup("opt-1", "Temp")],
      });
      const real = makeGroup("real-1", "Real Group");
      const next = conversationListReducer(state, {
        type: "REPLACE_OPTIMISTIC_GROUP",
        optimisticId: "opt-1",
        group: real,
      });
      expect(next.conversationGroups[0]!).toBe(real);
    });
  });

  describe("REMOVE_GROUP", () => {
    it("removes the matching group", () => {
      const state = stateWith({
        conversationGroups: [makeGroup("g1", "A"), makeGroup("g2", "B")],
      });
      const next = conversationListReducer(state, {
        type: "REMOVE_GROUP",
        groupId: "g1",
      });
      expect(next.conversationGroups).toHaveLength(1);
      expect(next.conversationGroups[0]!.id).toBe("g2");
    });
  });

  describe("DELETE_GROUP_AND_RESET_CONVERSATIONS", () => {
    it("removes the group and clears groupId on affected conversations", () => {
      const state = stateWith({
        conversations: [
          makeConversation("a", { groupId: "g1" }),
          makeConversation("b", { groupId: "g2" }),
        ],
        conversationGroups: [makeGroup("g1", "G1"), makeGroup("g2", "G2")],
      });
      const next = conversationListReducer(state, {
        type: "DELETE_GROUP_AND_RESET_CONVERSATIONS",
        groupId: "g1",
      });
      expect(next.conversationGroups).toHaveLength(1);
      expect(next.conversations[0]!.groupId).toBeUndefined();
      expect(next.conversations[1]!.groupId).toBe("g2");
    });
  });

  // ---------------------------------------------------------------------------
  // Active / editing key
  // ---------------------------------------------------------------------------

  describe("SET_ACTIVE_KEY", () => {
    it("sets the active conversation key", () => {
      const next = conversationListReducer(INITIAL_CONVERSATION_LIST_STATE, {
        type: "SET_ACTIVE_KEY",
        key: "abc",
      });
      expect(next.activeConversationKey).toBe("abc");
    });
  });

  describe("SET_EDITING_KEY", () => {
    it("sets the editing conversation key", () => {
      const next = conversationListReducer(INITIAL_CONVERSATION_LIST_STATE, {
        type: "SET_EDITING_KEY",
        key: "edit-1",
      });
      expect(next.editingConversationKey).toBe("edit-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Processing keys
  // ---------------------------------------------------------------------------

  describe("ADD_PROCESSING_KEY", () => {
    it("adds a key to the set", () => {
      const next = conversationListReducer(INITIAL_CONVERSATION_LIST_STATE, {
        type: "ADD_PROCESSING_KEY",
        key: "k1",
      });
      expect(next.processingKeys.has("k1")).toBe(true);
    });

    it("returns the same Set reference when key already present", () => {
      const state = stateWith({ processingKeys: new Set(["k1"]) });
      const next = conversationListReducer(state, {
        type: "ADD_PROCESSING_KEY",
        key: "k1",
      });
      expect(next.processingKeys).toBe(state.processingKeys);
    });
  });

  describe("REMOVE_PROCESSING_KEY", () => {
    it("removes a key from the set", () => {
      const state = stateWith({ processingKeys: new Set(["k1", "k2"]) });
      const next = conversationListReducer(state, {
        type: "REMOVE_PROCESSING_KEY",
        key: "k1",
      });
      expect(next.processingKeys.has("k1")).toBe(false);
      expect(next.processingKeys.has("k2")).toBe(true);
    });

    it("returns the same Set reference when key not present", () => {
      const state = stateWith({ processingKeys: new Set(["k1"]) });
      const next = conversationListReducer(state, {
        type: "REMOVE_PROCESSING_KEY",
        key: "missing",
      });
      expect(next.processingKeys).toBe(state.processingKeys);
    });
  });

  describe("REMOVE_MULTIPLE_PROCESSING_KEYS", () => {
    it("removes multiple keys at once", () => {
      const state = stateWith({ processingKeys: new Set(["a", "b", "c"]) });
      const next = conversationListReducer(state, {
        type: "REMOVE_MULTIPLE_PROCESSING_KEYS",
        keys: ["a", "c"],
      });
      expect(next.processingKeys.size).toBe(1);
      expect(next.processingKeys.has("b")).toBe(true);
    });

    it("returns same Set when no keys match", () => {
      const state = stateWith({ processingKeys: new Set(["a"]) });
      const next = conversationListReducer(state, {
        type: "REMOVE_MULTIPLE_PROCESSING_KEYS",
        keys: ["x", "y"],
      });
      expect(next.processingKeys).toBe(state.processingKeys);
    });
  });

  describe("TRANSFER_PROCESSING_KEY", () => {
    it("replaces oldKey with newKey", () => {
      const state = stateWith({ processingKeys: new Set(["old"]) });
      const next = conversationListReducer(state, {
        type: "TRANSFER_PROCESSING_KEY",
        oldKey: "old",
        newKey: "new",
      });
      expect(next.processingKeys.has("old")).toBe(false);
      expect(next.processingKeys.has("new")).toBe(true);
    });

    it("returns same state when oldKey not present", () => {
      const state = stateWith({ processingKeys: new Set(["other"]) });
      const next = conversationListReducer(state, {
        type: "TRANSFER_PROCESSING_KEY",
        oldKey: "missing",
        newKey: "new",
      });
      expect(next).toBe(state);
    });
  });

  // ---------------------------------------------------------------------------
  // Attention keys
  // ---------------------------------------------------------------------------

  describe("ADD_ATTENTION_KEY", () => {
    it("adds a key", () => {
      const next = conversationListReducer(INITIAL_CONVERSATION_LIST_STATE, {
        type: "ADD_ATTENTION_KEY",
        key: "a1",
      });
      expect(next.attentionKeys.has("a1")).toBe(true);
    });
  });

  describe("REMOVE_ATTENTION_KEY", () => {
    it("removes a key", () => {
      const state = stateWith({ attentionKeys: new Set(["a1"]) });
      const next = conversationListReducer(state, {
        type: "REMOVE_ATTENTION_KEY",
        key: "a1",
      });
      expect(next.attentionKeys.has("a1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Compound actions
  // ---------------------------------------------------------------------------

  describe("GRADUATE_PROCESSING_KEY", () => {
    it("removes from processing and adds to attention when interaction pending", () => {
      const state = stateWith({ processingKeys: new Set(["k1"]) });
      const next = conversationListReducer(state, {
        type: "GRADUATE_PROCESSING_KEY",
        key: "k1",
        hasPendingInteraction: true,
      });
      expect(next.processingKeys.has("k1")).toBe(false);
      expect(next.attentionKeys.has("k1")).toBe(true);
    });

    it("removes from processing without adding to attention when no interaction pending", () => {
      const state = stateWith({ processingKeys: new Set(["k1"]) });
      const next = conversationListReducer(state, {
        type: "GRADUATE_PROCESSING_KEY",
        key: "k1",
        hasPendingInteraction: false,
      });
      expect(next.processingKeys.has("k1")).toBe(false);
      expect(next.attentionKeys.has("k1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown action passthrough
  // ---------------------------------------------------------------------------

  it("returns the same state for an unknown action type", () => {
    const state = stateWith({ conversations: [makeConversation("a")] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = conversationListReducer(state, { type: "UNKNOWN" } as any);
    expect(next).toBe(state);
  });
});
