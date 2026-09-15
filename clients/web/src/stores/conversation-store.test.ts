import { afterEach, beforeEach, describe, it, expect } from "bun:test";

import {
  DRAFT_REPLACEMENTS_KEY,
  readStoredDraftReplacements,
  useConversationStore,
} from "@/stores/conversation-store";

function getState() {
  return useConversationStore.getState();
}

beforeEach(() => {
  sessionStorage.clear();
});

/**
 * Run `body` against a `sessionStorage` that throws on every access, the way a
 * private window or a policy that disables storage does.
 *
 * The global is replaced rather than `Storage.prototype` patched: happy-dom
 * serves `sessionStorage` from an accessor and hands out a method reference
 * that a later prototype assignment does not reach.
 */
function withBlockedStorage(body: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("storage is blocked");
    },
  });
  try {
    body();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, "sessionStorage", descriptor);
    }
  }
}

afterEach(() => {
  getState().reset();
  sessionStorage.clear();
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
      expect(
        getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1"),
      ).toBe(true);
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      expect(
        getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1"),
      ).toBe(false);
    });

    it("toggle accumulates multiple names for one conversation id", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      getState().togglePendingDraftPlugin("draft-a", "plugin-2");
      expect(
        getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1"),
      ).toBe(true);
      expect(
        getState().pendingDraftPlugins.get("draft-a")?.has("plugin-2"),
      ).toBe(true);
    });

    it("keeps independent selections for different conversation ids", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      getState().togglePendingDraftPlugin("draft-b", "plugin-2");
      expect(
        getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1"),
      ).toBe(true);
      expect(
        getState().pendingDraftPlugins.get("draft-a")?.has("plugin-2"),
      ).toBe(false);
      expect(
        getState().pendingDraftPlugins.get("draft-b")?.has("plugin-2"),
      ).toBe(true);
    });

    it("sets a selection set keyed by conversation id", () => {
      getState().setPendingDraftPlugins(
        "draft-a",
        new Set(["plugin-1", "plugin-2"]),
      );
      expect(getState().pendingDraftPlugins.get("draft-a")?.size).toBe(2);
      expect(
        getState().pendingDraftPlugins.get("draft-a")?.has("plugin-1"),
      ).toBe(true);
    });

    it("clears only the named id, leaving other drafts intact", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      getState().togglePendingDraftPlugin("draft-b", "plugin-2");
      getState().clearPendingDraftPlugins("draft-a");
      expect(getState().pendingDraftPlugins.has("draft-a")).toBe(false);
      expect(
        getState().pendingDraftPlugins.get("draft-b")?.has("plugin-2"),
      ).toBe(true);
    });

    it("clear is a no-op (same reference) when the id is absent", () => {
      getState().togglePendingDraftPlugin("draft-a", "plugin-1");
      const before = getState().pendingDraftPlugins;
      getState().clearPendingDraftPlugins("draft-z");
      expect(getState().pendingDraftPlugins).toBe(before);
    });
  });
});

describe("draft conversation ids", () => {
  it("registers and clears a draft key", () => {
    getState().registerDraftConversationId("draft-1");
    expect(getState().draftConversationIds.has("draft-1")).toBe(true);

    getState().clearDraftConversationId("draft-1");
    expect(getState().draftConversationIds.has("draft-1")).toBe(false);
  });

  it("keeps the same set reference when clearing an unknown key", () => {
    getState().registerDraftConversationId("draft-1");
    const before = getState().draftConversationIds;

    getState().clearDraftConversationId("never-registered");

    expect(getState().draftConversationIds).toBe(before);
  });

  it("drops every draft on reset", () => {
    getState().registerDraftConversationId("draft-1");
    getState().registerDraftConversationId("draft-2");

    getState().reset();

    expect(getState().draftConversationIds.size).toBe(0);
  });
});

describe("draft replacements", () => {
  it("records the id a send assigned a draft", () => {
    getState().recordDraftReplacement("draft-1", "conv-server-1");

    expect(getState().draftReplacements.get("draft-1")).toBe("conv-server-1");
  });

  it("records nothing for a draft the server kept the id of", () => {
    getState().recordDraftReplacement("draft-1", "draft-1");

    expect(getState().draftReplacements.size).toBe(0);
  });

  it("keeps the same map reference when the pair is already recorded", () => {
    getState().recordDraftReplacement("draft-1", "conv-server-1");
    const before = getState().draftReplacements;

    getState().recordDraftReplacement("draft-1", "conv-server-1");

    expect(getState().draftReplacements).toBe(before);
  });

  it("drops every replacement on reset", () => {
    getState().recordDraftReplacement("draft-1", "conv-server-1");

    getState().reset();

    expect(getState().draftReplacements.size).toBe(0);
  });

  it("stores the recorded pair for the rest of the tab's life", () => {
    getState().recordDraftReplacement("draft-1", "conv-server-1");

    expect(sessionStorage.getItem(DRAFT_REPLACEMENTS_KEY)).toBe(
      JSON.stringify({ "draft-1": "conv-server-1" }),
    );
  });

  it("keeps the 50 most recent pairs, so one tab cannot grow the key", () => {
    for (let i = 0; i < 60; i += 1) {
      getState().recordDraftReplacement(`draft-${i}`, `conv-${i}`);
    }

    expect(getState().draftReplacements.size).toBe(50);
    expect(getState().draftReplacements.has("draft-9")).toBe(false);
    expect(getState().draftReplacements.get("draft-10")).toBe("conv-10");
    expect(
      Object.keys(
        JSON.parse(
          sessionStorage.getItem(DRAFT_REPLACEMENTS_KEY) ?? "{}",
        ) as Record<string, string>,
      ),
    ).toHaveLength(50);
  });

  it("clears the stored key on reset", () => {
    getState().recordDraftReplacement("draft-1", "conv-server-1");

    getState().reset();

    expect(sessionStorage.getItem(DRAFT_REPLACEMENTS_KEY)).toBeNull();
  });

  it("still records the pair when storage refuses the write", () => {
    withBlockedStorage(() => {
      getState().recordDraftReplacement("draft-1", "conv-server-1");
    });

    expect(getState().draftReplacements.get("draft-1")).toBe("conv-server-1");
  });
});

describe("readStoredDraftReplacements", () => {
  it("reads back what a send recorded", () => {
    getState().recordDraftReplacement("draft-1", "conv-server-1");

    expect([...readStoredDraftReplacements()]).toEqual([
      ["draft-1", "conv-server-1"],
    ]);
  });

  it("is empty when nothing was stored", () => {
    expect(readStoredDraftReplacements().size).toBe(0);
  });

  it("is empty for a value that is not a map of ids", () => {
    sessionStorage.setItem(DRAFT_REPLACEMENTS_KEY, "not json");

    expect(readStoredDraftReplacements().size).toBe(0);
  });

  it("drops entries that do not name a server id", () => {
    sessionStorage.setItem(
      DRAFT_REPLACEMENTS_KEY,
      JSON.stringify({ "draft-1": "conv-server-1", "draft-2": 7 }),
    );

    expect([...readStoredDraftReplacements()]).toEqual([
      ["draft-1", "conv-server-1"],
    ]);
  });

  it("is empty when storage refuses the read", () => {
    sessionStorage.setItem(
      DRAFT_REPLACEMENTS_KEY,
      JSON.stringify({ "draft-1": "conv-server-1" }),
    );

    withBlockedStorage(() => {
      expect(readStoredDraftReplacements().size).toBe(0);
    });
  });

  it("seeds a store that loads after the pair was stored", async () => {
    sessionStorage.setItem(
      DRAFT_REPLACEMENTS_KEY,
      JSON.stringify({ "draft-1": "conv-server-1" }),
    );

    /* A reload is a fresh module graph; the query makes this import one too
       instead of handing back the copy this file already holds. */
    const reloaded = (await import(
      `./conversation-store.ts?reload=${Date.now()}`
    )) as typeof import("@/stores/conversation-store");

    expect(
      reloaded.useConversationStore.getState().draftReplacements.get("draft-1"),
    ).toBe("conv-server-1");
  });
});
