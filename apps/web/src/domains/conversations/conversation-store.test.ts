import { afterEach, describe, it, expect } from "bun:test";

import { useConversationStore } from "@/domains/conversations/conversation-store.js";

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
    getState().setActiveKey("a");
    getState().setEditingKey("edit");
    getState().addProcessingKey("k1");
    getState().addAttentionKey("a1");
    getState().reset();
    expect(getState().activeConversationKey).toBeNull();
    expect(getState().editingConversationKey).toBeNull();
    expect(getState().processingKeys.size).toBe(0);
    expect(getState().attentionKeys.size).toBe(0);
  });
});
