import { describe, expect, test } from "bun:test";

import type { Conversation } from "@/types/conversation-types";
import { listPage } from "@/utils/conversation-list.test-helper";

import {
  activeConversationsByRecency,
  compareByRecency,
  insertByRecency,
  insertIntoWindow,
  lastActivityAt,
} from "./conversation-order";

function row(conversationId: string, lastMessageAt: number): Conversation {
  return { conversationId, title: conversationId, createdAt: 1, lastMessageAt };
}

describe("activeConversationsByRecency", () => {
  test("drops archived rows and orders the rest newest first", () => {
    const rows = [
      row("older", 1_000),
      { ...row("archived", 3_000), archivedAt: 3_000 },
      row("newest", 2_000),
    ];

    expect(
      activeConversationsByRecency(rows).map((c) => c.conversationId),
    ).toEqual(["newest", "older"]);
  });

  test("leaves the caller's list alone", () => {
    // Both native mirrors pass the list straight out of the query cache.
    const rows = [row("older", 1_000), row("newest", 2_000)];

    activeConversationsByRecency(rows);

    expect(rows.map((c) => c.conversationId)).toEqual(["older", "newest"]);
  });
});

describe("compareByRecency", () => {
  test("files a done row by when it was marked done", () => {
    const rows = [
      row("recent", 2_000),
      { ...row("marked-done-now", 1_000), archivedAt: 3_000 },
      { ...row("replied-after-done", 1_500), archivedAt: 500 },
    ];

    expect(rows.sort(compareByRecency).map((c) => c.conversationId)).toEqual([
      "marked-done-now",
      "recent",
      "replied-after-done",
    ]);
  });
});

describe("lastActivityAt", () => {
  test("is the last message for an active row", () => {
    expect(lastActivityAt(row("active", 2_000))).toBe(2_000);
  });

  test("is the later of the last message and the done time", () => {
    expect(lastActivityAt({ ...row("done", 1_000), archivedAt: 3_000 })).toBe(
      3_000,
    );
    expect(lastActivityAt({ ...row("done", 4_000), archivedAt: 3_000 })).toBe(
      4_000,
    );
  });

  test("is undefined for a draft with neither", () => {
    expect(
      lastActivityAt({ lastMessageAt: undefined, archivedAt: undefined }),
    ).toBeUndefined();
  });
});

describe("insertByRecency", () => {
  test("ties place the new row first among its peers", () => {
    // The server leads with a just-touched row over the rows it ties with;
    // placing it after them would jump it forward on the next refetch.
    const result = insertByRecency(
      [row("a", 2_000), row("b", 2_000)],
      row("touched", 2_000),
    );
    expect(result.map((c) => c.conversationId)).toEqual(["touched", "a", "b"]);
  });
});

describe("insertIntoWindow", () => {
  const windowRows = [row("newest", 3_000), row("bottom", 2_000)];

  test("drops a row strictly older than a window's last row", () => {
    const page = listPage(windowRows, true);
    const result = insertIntoWindow(page, row("ancient", 1_000));
    // Same reference, not just same contents: callers use identity to tell
    // "dropped" from "inserted" and skip the cache write entirely.
    expect(result).toBe(page);
  });

  test("a tie with the window's last row inserts, leading the tie", () => {
    // The drop rule is strict: an equal timestamp is inside the window,
    // and the tie places the new row first, as insertByRecency always does.
    const result = insertIntoWindow(
      listPage(windowRows, true),
      row("tied", 2_000),
    );
    expect(result.conversations.map((c) => c.conversationId)).toEqual([
      "newest",
      "tied",
      "bottom",
    ]);
    expect(result.hasMore).toBe(true);
  });

  test("an empty window inserts even under hasMore", () => {
    // Transient state: optimistic removals emptied a window whose deeper
    // pages never loaded. There is no window bottom to compare against, and
    // showing the row beats showing nothing.
    const result = insertIntoWindow(listPage([], true), row("only", 1_000));
    expect(result.conversations.map((c) => c.conversationId)).toEqual(["only"]);
    expect(result.hasMore).toBe(true);
  });

  test("a complete list appends a row older than everything", () => {
    const result = insertIntoWindow(
      listPage(windowRows, false),
      row("ancient", 1_000),
    );
    expect(result.conversations.map((c) => c.conversationId)).toEqual([
      "newest",
      "bottom",
      "ancient",
    ]);
    expect(result.hasMore).toBe(false);
  });
});
