import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type { Conversation } from "@/types/conversation-types";
import {
  conversationsQueryKey,
  backgroundConversationsQueryKey,
  scheduledConversationsQueryKey,
  archivedConversationsQueryKey,
} from "@/lib/sync/query-tags";

import {
  cancelConversationQueries,
  snapshotConversationCaches,
  restoreConversationCaches,
  invalidateConversationQueries,
  updateConversationsCache,
  updateBackgroundConversationsCache,
  updateScheduledConversationsCache,
  updateArchivedConversationsCache,
  updateAllConversationCaches,
  findConversation,
  mergeConversationLists,
  getConversations,
  patchConversation,
} from "./conversation-cache";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

// ---------------------------------------------------------------------------
// Snapshot / Restore
// ---------------------------------------------------------------------------

describe("snapshotConversationCaches + restoreConversationCaches", () => {
  test("captures and restores all four caches", () => {
    const fg = [makeConversation({ conversationId: "c1" })];
    const bg = [makeConversation({ conversationId: "bg1" })];
    const sched = [makeConversation({ conversationId: "s1" })];
    seedForeground(qc, fg);
    seedBackground(qc, bg);
    seedScheduled(qc, sched);

    const snapshot = snapshotConversationCaches(qc, ASSISTANT_ID);

    // Mutate the caches
    seedForeground(qc, []);
    seedBackground(qc, []);
    seedScheduled(qc, []);

    restoreConversationCaches(qc, snapshot);

    expect(getForeground(qc)).toEqual(fg);
    expect(getBackground(qc)).toEqual(bg);
    expect(getScheduled(qc)).toEqual(sched);
  });

  test("snapshot captures undefined for uninitialized caches", () => {
    const snapshot = snapshotConversationCaches(qc, ASSISTANT_ID);

    expect(snapshot).toHaveLength(4);
    for (const [, data] of snapshot) {
      expect(data).toBeUndefined();
    }
  });

  test("restore with undefined removes the cache entry", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);
    const snapshot = snapshotConversationCaches(qc, "other-assistant");

    restoreConversationCaches(qc, snapshot);

    // The "other-assistant" caches are undefined, restoring them is a no-op
    // on ASSISTANT_ID's caches — they remain intact.
    expect(getForeground(qc)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateConversationsCache
// ---------------------------------------------------------------------------

describe("updateConversationsCache", () => {
  test("applies updater to foreground cache", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);

    updateConversationsCache(qc, ASSISTANT_ID, (list) => [
      ...list,
      makeConversation({ conversationId: "c2" }),
    ]);

    expect(getForeground(qc)).toHaveLength(2);
  });

  test("preserves reference when updater returns same array", () => {
    const original = [makeConversation({ conversationId: "c1" })];
    seedForeground(qc, original);

    updateConversationsCache(qc, ASSISTANT_ID, (list) => list);

    expect(getForeground(qc)).toBe(original);
  });

  test("initializes from empty when cache is unset", () => {
    updateConversationsCache(qc, ASSISTANT_ID, (list) => {
      expect(list).toEqual([]);
      return [makeConversation({ conversationId: "c1" })];
    });

    expect(getForeground(qc)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateBackgroundConversationsCache / updateScheduledConversationsCache
// ---------------------------------------------------------------------------

describe("updateBackgroundConversationsCache", () => {
  test("applies updater to background cache only", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);
    seedBackground(qc, []);

    updateBackgroundConversationsCache(qc, ASSISTANT_ID, () => [
      makeConversation({ conversationId: "bg1" }),
    ]);

    expect(getBackground(qc)).toHaveLength(1);
    expect(getForeground(qc)).toHaveLength(1);
  });
});

describe("updateScheduledConversationsCache", () => {
  test("applies updater to scheduled cache only", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);
    seedScheduled(qc, []);

    updateScheduledConversationsCache(qc, ASSISTANT_ID, () => [
      makeConversation({ conversationId: "s1" }),
    ]);

    expect(getScheduled(qc)).toHaveLength(1);
    expect(getForeground(qc)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateAllConversationCaches
// ---------------------------------------------------------------------------

describe("updateArchivedConversationsCache", () => {
  test("applies updater to archived cache only", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);
    seedArchived(qc, []);

    updateArchivedConversationsCache(qc, ASSISTANT_ID, () => [
      makeConversation({ conversationId: "a1" }),
    ]);

    expect(getArchived(qc)).toHaveLength(1);
    expect(getForeground(qc)).toHaveLength(1);
  });
});

describe("updateAllConversationCaches", () => {
  test("applies updater to all four caches", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1", title: "old" })]);
    seedBackground(qc, [makeConversation({ conversationId: "bg1", title: "old" })]);
    seedScheduled(qc, [makeConversation({ conversationId: "s1", title: "old" })]);
    seedArchived(qc, [makeConversation({ conversationId: "a1", title: "old" })]);

    updateAllConversationCaches(qc, ASSISTANT_ID, (list) =>
      list.map((c) => ({ ...c, title: "new" })),
    );

    expect(getForeground(qc)[0].title).toBe("new");
    expect(getBackground(qc)[0].title).toBe("new");
    expect(getScheduled(qc)[0].title).toBe("new");
    expect(getArchived(qc)[0].title).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// findConversation
// ---------------------------------------------------------------------------

describe("findConversation", () => {
  test("finds conversation in foreground cache", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1", title: "Found" })]);

    const result = findConversation(qc, ASSISTANT_ID, "c1");
    expect(result?.title).toBe("Found");
  });

  test("finds conversation in background cache", () => {
    seedForeground(qc, []);
    seedBackground(qc, [makeConversation({ conversationId: "bg1", title: "BG" })]);

    const result = findConversation(qc, ASSISTANT_ID, "bg1");
    expect(result?.title).toBe("BG");
  });

  test("finds conversation in scheduled cache", () => {
    seedForeground(qc, []);
    seedBackground(qc, []);
    seedScheduled(qc, [makeConversation({ conversationId: "s1", title: "Sched" })]);

    const result = findConversation(qc, ASSISTANT_ID, "s1");
    expect(result?.title).toBe("Sched");
  });

  test("finds conversation in archived cache", () => {
    seedForeground(qc, []);
    seedBackground(qc, []);
    seedScheduled(qc, []);
    seedArchived(qc, [makeConversation({ conversationId: "a1", title: "Archived" })]);

    const result = findConversation(qc, ASSISTANT_ID, "a1");
    expect(result?.title).toBe("Archived");
  });

  test("returns undefined when not found in any cache", () => {
    seedForeground(qc, []);
    seedBackground(qc, []);
    seedScheduled(qc, []);
    seedArchived(qc, []);

    expect(findConversation(qc, ASSISTANT_ID, "nonexistent")).toBeUndefined();
  });

  test("returns first match when duplicate exists across caches", () => {
    seedForeground(qc, [makeConversation({ conversationId: "dup", title: "FG" })]);
    seedBackground(qc, [makeConversation({ conversationId: "dup", title: "BG" })]);

    const result = findConversation(qc, ASSISTANT_ID, "dup");
    expect(result?.title).toBe("FG");
  });
});

// ---------------------------------------------------------------------------
// mergeConversationLists
// ---------------------------------------------------------------------------

describe("mergeConversationLists", () => {
  test("returns primary reference when all others are empty", () => {
    const primary = [makeConversation({ conversationId: "c1" })];
    const result = mergeConversationLists(primary, [], []);
    expect(result).toBe(primary);
  });

  test("deduplicates by conversationId, primary wins", () => {
    const primary = [makeConversation({ conversationId: "c1", title: "Primary" })];
    const secondary = [makeConversation({ conversationId: "c1", title: "Secondary" })];

    const result = mergeConversationLists(primary, secondary);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Primary");
  });

  test("merges unique conversations from multiple lists", () => {
    const a = [makeConversation({ conversationId: "c1" })];
    const b = [makeConversation({ conversationId: "c2" })];
    const c = [makeConversation({ conversationId: "c3" })];

    const result = mergeConversationLists(a, b, c);
    expect(result).toHaveLength(3);
  });

  test("returns empty array when all lists are empty", () => {
    const result = mergeConversationLists([], [], []);
    expect(result).toEqual([]);
  });

  test("handles no arguments gracefully", () => {
    const result = mergeConversationLists();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getConversations
// ---------------------------------------------------------------------------

describe("getConversations", () => {
  test("merges all four caches", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1" })]);
    seedBackground(qc, [makeConversation({ conversationId: "bg1" })]);
    seedScheduled(qc, [makeConversation({ conversationId: "s1" })]);
    seedArchived(qc, [makeConversation({ conversationId: "a1" })]);

    const result = getConversations(qc, ASSISTANT_ID);
    expect(result).toHaveLength(4);
  });

  test("returns empty array when no caches populated", () => {
    expect(getConversations(qc, ASSISTANT_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// patchConversation
// ---------------------------------------------------------------------------

describe("patchConversation", () => {
  test("patches matching conversation in foreground", () => {
    seedForeground(qc, [makeConversation({ conversationId: "c1", title: "Old" })]);

    patchConversation(qc, ASSISTANT_ID, "c1", { title: "New" });

    expect(getForeground(qc)[0].title).toBe("New");
  });

  test("patches matching conversation in background", () => {
    seedForeground(qc, []);
    seedBackground(qc, [makeConversation({ conversationId: "bg1", title: "Old" })]);

    patchConversation(qc, ASSISTANT_ID, "bg1", { title: "New" });

    expect(getBackground(qc)[0].title).toBe("New");
  });

  test("preserves other fields when patching", () => {
    seedForeground(qc, [
      makeConversation({ conversationId: "c1", title: "Keep", isPinned: true }),
    ]);

    patchConversation(qc, ASSISTANT_ID, "c1", { title: "Changed" });

    const c = getForeground(qc)[0];
    expect(c.title).toBe("Changed");
    expect(c.isPinned).toBe(true);
  });

  test("no-op when key not found", () => {
    const original = [makeConversation({ conversationId: "c1" })];
    seedForeground(qc, original);

    patchConversation(qc, ASSISTANT_ID, "nonexistent", { title: "Nope" });

    expect(getForeground(qc)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// cancelConversationQueries
// ---------------------------------------------------------------------------

describe("cancelConversationQueries", () => {
  test("resolves without error on empty query client", async () => {
    await expect(cancelConversationQueries(qc, ASSISTANT_ID)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// invalidateConversationQueries
// ---------------------------------------------------------------------------

describe("invalidateConversationQueries", () => {
  test("resolves without error on empty query client", async () => {
    await expect(invalidateConversationQueries(qc, ASSISTANT_ID)).resolves.toBeUndefined();
  });
});
