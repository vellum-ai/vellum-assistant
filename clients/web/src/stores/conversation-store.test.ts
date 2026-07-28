import { afterEach, describe, it, expect } from "bun:test";

import { useConversationStore } from "@/stores/conversation-store";

function getState() {
  return useConversationStore.getState();
}

afterEach(() => {
  getState().reset();
});

describe("useConversationStore", () => {
  // ---------------------------------------------------------------------------
  // Active / editing key
  // ---------------------------------------------------------------------------

  describe("setActiveConversationId", () => {
    it("sets the active conversation key", () => {
      getState().setActiveConversationId("abc");
      expect(getState().activeConversationId).toBe("abc");
    });
  });

  describe("setEditingConversationId", () => {
    it("sets the editing conversation key", () => {
      getState().setEditingConversationId("edit-1");
      expect(getState().editingConversationId).toBe("edit-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Processing keys
  // ---------------------------------------------------------------------------

  describe("addProcessingConversationId", () => {
    it("adds a key to the set", () => {
      getState().addProcessingConversationId("k1");
      expect(getState().processingConversationIds.has("k1")).toBe(true);
    });

    it("returns the same Set reference when key already present", () => {
      getState().addProcessingConversationId("k1");
      const before = getState().processingConversationIds;
      getState().addProcessingConversationId("k1");
      expect(getState().processingConversationIds).toBe(before);
    });
  });

  describe("removeProcessingConversationId", () => {
    it("removes a key from the set", () => {
      getState().addProcessingConversationId("k1");
      getState().addProcessingConversationId("k2");
      getState().removeProcessingConversationId("k1");
      expect(getState().processingConversationIds.has("k1")).toBe(false);
      expect(getState().processingConversationIds.has("k2")).toBe(true);
    });

    it("returns the same Set reference when key not present", () => {
      getState().addProcessingConversationId("k1");
      const before = getState().processingConversationIds;
      getState().removeProcessingConversationId("missing");
      expect(getState().processingConversationIds).toBe(before);
    });
  });

  describe("removeMultipleProcessingConversationIds", () => {
    it("removes multiple keys at once", () => {
      getState().addProcessingConversationId("a");
      getState().addProcessingConversationId("b");
      getState().addProcessingConversationId("c");
      getState().removeMultipleProcessingConversationIds(["a", "c"]);
      expect(getState().processingConversationIds.size).toBe(1);
      expect(getState().processingConversationIds.has("b")).toBe(true);
    });

    it("returns same Set when no keys match", () => {
      getState().addProcessingConversationId("a");
      const before = getState().processingConversationIds;
      getState().removeMultipleProcessingConversationIds(["x", "y"]);
      expect(getState().processingConversationIds).toBe(before);
    });
  });

  describe("transferProcessingConversationId", () => {
    it("replaces oldKey with newKey", () => {
      getState().addProcessingConversationId("old");
      getState().transferProcessingConversationId("old", "new");
      expect(getState().processingConversationIds.has("old")).toBe(false);
      expect(getState().processingConversationIds.has("new")).toBe(true);
    });

    it("is a no-op when oldKey not present", () => {
      getState().addProcessingConversationId("other");
      const before = getState().processingConversationIds;
      getState().transferProcessingConversationId("missing", "new");
      expect(getState().processingConversationIds).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Attention keys
  // ---------------------------------------------------------------------------

  describe("addAttentionConversationId", () => {
    it("adds a key", () => {
      getState().addAttentionConversationId("a1");
      expect(getState().attentionConversationIds.has("a1")).toBe(true);
    });
  });

  describe("removeAttentionConversationId", () => {
    it("removes a key", () => {
      getState().addAttentionConversationId("a1");
      getState().removeAttentionConversationId("a1");
      expect(getState().attentionConversationIds.has("a1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Compound actions
  // ---------------------------------------------------------------------------

  describe("graduateProcessingConversationId", () => {
    it("removes from processing and adds to attention when interaction pending", () => {
      getState().addProcessingConversationId("k1");
      getState().graduateProcessingConversationId("k1", true);
      expect(getState().processingConversationIds.has("k1")).toBe(false);
      expect(getState().attentionConversationIds.has("k1")).toBe(true);
    });

    it("removes from processing without adding to attention when no interaction pending", () => {
      getState().addProcessingConversationId("k1");
      getState().graduateProcessingConversationId("k1", false);
      expect(getState().processingConversationIds.has("k1")).toBe(false);
      expect(getState().attentionConversationIds.has("k1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  it("reset clears all state", () => {
    getState().setActiveConversationId("a");
    getState().setEditingConversationId("edit");
    getState().addProcessingConversationId("k1");
    getState().addAttentionConversationId("a1");
    getState().setPendingDraftProfile("draft-a", "smart");
    getState().togglePendingDraftPlugin("draft-a", "plugin-1");
    getState().reset();
    expect(getState().activeConversationId).toBeNull();
    expect(getState().editingConversationId).toBeNull();
    expect(getState().processingConversationIds.size).toBe(0);
    expect(getState().attentionConversationIds.size).toBe(0);
    expect(getState().pendingDraftProfiles.size).toBe(0);
    expect(getState().pendingDraftPlugins.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Pending draft profiles
  // ---------------------------------------------------------------------------

  describe("pendingDraftProfiles", () => {
    it("stashes a profile keyed by conversation id", () => {
      getState().setPendingDraftProfile("draft-a", "smart");
      expect(getState().pendingDraftProfiles.get("draft-a")).toBe("smart");
    });

    it("preserves each draft's selection when several are unsent", () => {
      getState().setPendingDraftProfile("draft-a", "smart");
      getState().setPendingDraftProfile("draft-b", "fast");
      expect(getState().pendingDraftProfiles.get("draft-a")).toBe("smart");
      expect(getState().pendingDraftProfiles.get("draft-b")).toBe("fast");
    });

    it("clears only the named id, leaving other drafts intact", () => {
      // Draft A's send was in flight with "smart"; the user then switched to
      // draft B and picked "fast" before A's POST resolved. Clearing A must not
      // wipe B's selection.
      getState().setPendingDraftProfile("draft-a", "smart");
      getState().setPendingDraftProfile("draft-b", "fast");
      getState().clearPendingDraftProfile("draft-a");
      expect(getState().pendingDraftProfiles.has("draft-a")).toBe(false);
      expect(getState().pendingDraftProfiles.get("draft-b")).toBe("fast");
    });

    it("returns the same Map reference when setting an unchanged value", () => {
      getState().setPendingDraftProfile("draft-a", "smart");
      const before = getState().pendingDraftProfiles;
      getState().setPendingDraftProfile("draft-a", "smart");
      expect(getState().pendingDraftProfiles).toBe(before);
    });

    it("clear is a no-op (same reference) when the id is absent", () => {
      getState().setPendingDraftProfile("draft-a", "smart");
      const before = getState().pendingDraftProfiles;
      getState().clearPendingDraftProfile("draft-z");
      expect(getState().pendingDraftProfiles).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------
  // Pending draft plugins
  // ---------------------------------------------------------------------------

  describe("pendingDraftPlugins", () => {
    it("toggle adds then removes a name for a conversation id", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      expect(getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1")).toBe(true);
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      expect(getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1")).toBe(false);
    });

    it("toggle accumulates multiple names for one conversation id", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      getState().togglePendingDraftPlugin("draft-a", "plugin-2");
      expect(getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1")).toBe(true);
      expect(getState().pendingDraftPlugins.get("draft-a")?.has("plugin-2")).toBe(true);
    });

    it("keeps independent selections for different conversation ids", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      getState().togglePendingDraftPlugin("draft-b", "plugin-2");
      expect(getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1")).toBe(true);
      expect(getState().pendingDraftPlugins.get("draft-a")?.has("plugin-2")).toBe(false);
      expect(getState().pendingDraftPlugins.get("draft-b")?.has("plugin-2")).toBe(true);
    });

    it("sets a selection set keyed by conversation id", () => {
      getState().setPendingDraftPlugins("draft-a", new Set(["plugin-1", "plugin-2"]));
      expect(getState().pendingDraftPlugins.get("draft-a")?.size).toBe(2);
      expect(getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1")).toBe(true);
    });

    it("clears only the named id, leaving other drafts intact", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      getState().togglePendingDraftPlugin("draft-b", "plugin-2");
      getState().clearPendingDraftPlugins("draft-a");
      expect(getState().pendingDraftPlugins.has("draft-a")).toBe(false);
      expect(getState().pendingDraftPlugins.get("draft-b")?.has("plugin-2")).toBe(true);
    });

    it("clear is a no-op (same reference) when the id is absent", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      const before = getState().pendingDraftPlugins;
      getState().clearPendingDraftPlugins("draft-z");
      expect(getState().pendingDraftPlugins).toBe(before);
    });
  });
});
