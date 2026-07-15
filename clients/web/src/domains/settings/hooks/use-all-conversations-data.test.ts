import { describe, expect, test } from "bun:test";

import {
  filterBySearch,
  filterByState,
  mergeConversations,
} from "@/domains/settings/hooks/use-all-conversations-data.helpers";
import type { Conversation } from "@/types/conversation-types";

function conv(
  conversationId: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return { conversationId, ...overrides };
}

describe("mergeConversations", () => {
  test("dedupes by conversationId, archived list winning the archived flag", () => {
    const active = [conv("a"), conv("shared")];
    const archived = [conv("b"), conv("shared")];

    const rows = mergeConversations([active], archived);

    expect(rows).toHaveLength(3);
    const shared = rows.find(
      (row) => row.conversation.conversationId === "shared",
    );
    // The archived list is authoritative for the archived flag even when the
    // same conversation also appears in the active list.
    expect(shared?.archived).toBe(true);
  });

  test("marks active-only rows unarchived and archived-only rows archived", () => {
    const rows = mergeConversations([[conv("a")]], [conv("b")]);

    const byId = new Map(
      rows.map((row) => [row.conversation.conversationId, row]),
    );
    expect(byId.get("a")?.archived).toBe(false);
    expect(byId.get("b")?.archived).toBe(true);
  });

  test("treats an active-list row with archivedAt as archived", () => {
    const rows = mergeConversations([[conv("a", { archivedAt: 123 })]], []);
    expect(rows[0]?.archived).toBe(true);
  });

  test("includes background and scheduled active rows, not just foreground", () => {
    const foreground = [conv("fg")];
    const background = [conv("bg")];
    const scheduled = [conv("sched")];

    const rows = mergeConversations(
      [foreground, background, scheduled],
      [conv("arch")],
    );

    const ids = new Set(rows.map((row) => row.conversation.conversationId));
    // The page promises "every conversation" — active background and scheduled
    // rows must appear alongside foreground and archived ones.
    expect(ids).toEqual(new Set(["fg", "bg", "sched", "arch"]));
    const byId = new Map(
      rows.map((row) => [row.conversation.conversationId, row]),
    );
    expect(byId.get("bg")?.archived).toBe(false);
    expect(byId.get("sched")?.archived).toBe(false);
    expect(byId.get("arch")?.archived).toBe(true);
  });

  test("dedupes a conversation that appears in more than one active list", () => {
    // A scheduled job can also surface in the foreground backlog; it must
    // collapse to a single row rather than double-count.
    const rows = mergeConversations(
      [[conv("dup")], [conv("dup")], [conv("dup")]],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversation.conversationId).toBe("dup");
    expect(rows[0]?.archived).toBe(false);
  });

  test("lets the archived list override a row present in any active list", () => {
    // Even when a conversation is in background/scheduled, the archived list
    // is authoritative for the flag.
    const rows = mergeConversations(
      [[conv("x")], [conv("x")]],
      [conv("x")],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.archived).toBe(true);
  });

  test("sorts most-recently-touched first, preferring lastMessageAt over createdAt", () => {
    const rows = mergeConversations(
      [
        [
          conv("old", { createdAt: 100 }),
          conv("newest", { lastMessageAt: 900, createdAt: 200 }),
          conv("middle", { lastMessageAt: 500 }),
        ],
      ],
      [],
    );

    expect(rows.map((row) => row.conversation.conversationId)).toEqual([
      "newest",
      "middle",
      "old",
    ]);
  });

  test("returns an empty list when both sources are empty", () => {
    expect(mergeConversations([], [])).toEqual([]);
    expect(mergeConversations([[], [], []], [])).toEqual([]);
  });
});

describe("filterByState", () => {
  const rows = [
    { conversation: conv("active"), archived: false },
    { conversation: conv("archived"), archived: true },
  ];

  test("'all' returns every row", () => {
    expect(filterByState(rows, "all")).toHaveLength(2);
  });

  test("'active' returns only unarchived rows", () => {
    const result = filterByState(rows, "active");
    expect(result).toHaveLength(1);
    expect(result[0]?.conversation.conversationId).toBe("active");
  });

  test("'archived' returns only archived rows", () => {
    const result = filterByState(rows, "archived");
    expect(result).toHaveLength(1);
    expect(result[0]?.conversation.conversationId).toBe("archived");
  });
});

describe("filterBySearch", () => {
  const rows = [
    {
      conversation: conv("a", { title: "Quarterly Planning" }),
      archived: false,
    },
    { conversation: conv("b", { title: "grocery list" }), archived: false },
    { conversation: conv("c"), archived: false },
  ];

  test("returns all rows for an empty or whitespace query", () => {
    expect(filterBySearch(rows, "")).toHaveLength(3);
    expect(filterBySearch(rows, "   ")).toHaveLength(3);
  });

  test("matches titles case-insensitively", () => {
    const result = filterBySearch(rows, "PLANNING");
    expect(result).toHaveLength(1);
    expect(result[0]?.conversation.conversationId).toBe("a");
  });

  test("matches on a substring", () => {
    const result = filterBySearch(rows, "list");
    expect(result).toHaveLength(1);
    expect(result[0]?.conversation.conversationId).toBe("b");
  });

  test("never matches rows without a title", () => {
    const result = filterBySearch(rows, "c");
    expect(result.some((row) => row.conversation.conversationId === "c")).toBe(
      false,
    );
  });
});
