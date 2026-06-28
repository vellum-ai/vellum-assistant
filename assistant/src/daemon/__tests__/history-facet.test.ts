/**
 * Verifies the read-only history facet exposed on the external-plugin host:
 *
 * 1. A plugin reads recent conversation history and the conversation header
 *    through `host.history` alone — its code imports nothing from
 *    `persistence/` or `memory/`. The facet is the only route to the DB.
 * 2. The facet applies the same trust/visibility filtering the UI-facing
 *    history loads use: rows flagged `hidden` in metadata and non-`user`/
 *    `assistant` roles (e.g. agent-context `system` scaffolding) are dropped.
 *
 * The persistence delegates are stubbed with `mock.module`, so the test
 * touches no real DB. The `getMessagesPaginated` stub honors the filter
 * callback the facet hands it (exactly as the real implementation does), so
 * the visibility assertions exercise the facet's own predicate.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Seed rows + persistence stubs — installed before importing the facet module
// ---------------------------------------------------------------------------

interface SeedRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
  clientMessageId: string | null;
}

// Oldest→newest. Includes a `hidden` row and a `system` row that the facet
// must filter out.
const SEED_ROWS: SeedRow[] = [
  {
    id: "m1",
    conversationId: "conv-1",
    role: "user",
    content: "first user turn",
    createdAt: 1000,
    metadata: null,
    clientMessageId: null,
  },
  {
    id: "m2",
    conversationId: "conv-1",
    role: "assistant",
    content: "first assistant turn",
    createdAt: 2000,
    metadata: null,
    clientMessageId: null,
  },
  {
    id: "m3",
    conversationId: "conv-1",
    role: "assistant",
    content: "hidden scaffolding",
    createdAt: 3000,
    metadata: JSON.stringify({ hidden: true }),
    clientMessageId: null,
  },
  {
    id: "m4",
    conversationId: "conv-1",
    role: "system",
    content: "agent-context system row",
    createdAt: 4000,
    metadata: null,
    clientMessageId: null,
  },
  {
    id: "m5",
    conversationId: "conv-1",
    role: "user",
    content: "second user turn",
    createdAt: 5000,
    metadata: null,
    clientMessageId: null,
  },
];

const getConversationSpy = mock((id: string) =>
  id === "conv-1"
    ? {
        id: "conv-1",
        title: "Test Conversation",
        createdAt: 1000,
        updatedAt: 5000,
        conversationType: "standard",
        source: "user",
        lastMessageAt: 5000,
        archivedAt: null,
        // Extra ConversationRow fields the facet projects away.
        totalInputTokens: 0,
        totalOutputTokens: 0,
        memoryScopeId: "scope",
      }
    : null,
);

// Faithful-enough stand-in for `getMessagesPaginated`: applies the caller's
// `filter` callback (the facet's visibility predicate) and returns the newest
// `limit` matches oldest→newest, mirroring the real ordering contract. Honors
// the composite `(beforeTimestamp, beforeId)` cursor the same way the real
// query does — `created_at < ts OR (created_at = ts AND id < beforeId)` — so
// same-millisecond rows split across a page boundary are not skipped.
const getMessagesPaginatedSpy = mock(
  (
    conversationId: string,
    limit: number | undefined,
    beforeTimestamp: number | undefined,
    filter?: (row: SeedRow) => boolean,
    beforeId?: string,
  ) => {
    let rows = SEED_ROWS.filter((r) => r.conversationId === conversationId);
    if (beforeTimestamp !== undefined) {
      rows = rows.filter((r) =>
        beforeId === undefined
          ? r.createdAt < beforeTimestamp
          : r.createdAt < beforeTimestamp ||
            (r.createdAt === beforeTimestamp && r.id < beforeId),
      );
    }
    // Newest→oldest by `(createdAt, id)`, the order the real query scans in.
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const visible = filter ? rows.filter(filter) : rows;
    if (limit === undefined) {
      visible.reverse();
      return { messages: visible, hasMore: false };
    }
    const page = visible.slice(0, limit).reverse();
    const hasMore = visible.length > limit;
    return { messages: page, hasMore };
  },
);

mock.module("../../persistence/conversation-crud.js", () => ({
  addMessage: mock(async () => ({ id: "msg-123" })),
  getConversation: getConversationSpy,
  getMessagesPaginated: getMessagesPaginatedSpy,
}));

mock.module("../../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async () => ({ invoked: true }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import type { HistoryFacet } from "../../plugin-api/types.js";
import { buildHistoryFacet } from "../skill-host-facets.js";

/**
 * A stand-in for plugin code: it reaches the DB ONLY through the facet handed
 * to it — never importing `persistence/` or `memory/`.
 */
async function pluginReadsRecentTurns(
  history: HistoryFacet,
  conversationId: string,
  n: number,
) {
  const conversation = await history.getConversation(conversationId);
  const messages = await history.getRecentMessages(conversationId, n);
  return { conversation, messages };
}

describe("history facet", () => {
  test("a plugin reads the conversation header via the facet", async () => {
    const history = buildHistoryFacet();
    const { conversation } = await pluginReadsRecentTurns(
      history,
      "conv-1",
      10,
    );

    expect(conversation).toEqual({
      id: "conv-1",
      title: "Test Conversation",
      conversationType: "standard",
      source: "user",
      createdAt: 1000,
      updatedAt: 5000,
      lastMessageAt: 5000,
      archivedAt: null,
    });
  });

  test("getConversation returns null for an unknown conversation", async () => {
    const history = buildHistoryFacet();
    expect(await history.getConversation("nope")).toBeNull();
  });

  test("getRecentMessages drops hidden + non-user/assistant rows", async () => {
    const history = buildHistoryFacet();
    const { messages } = await pluginReadsRecentTurns(history, "conv-1", 10);

    // m3 (hidden) and m4 (system) are filtered out; m1/m2/m5 survive,
    // oldest→newest.
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m5"]);
    for (const m of messages) {
      expect(m.role === "user" || m.role === "assistant").toBe(true);
    }
    expect(messages[0]).toEqual({
      id: "m1",
      conversationId: "conv-1",
      role: "user",
      content: "first user turn",
      createdAt: 1000,
      metadata: null,
    });
  });

  test("getRecentMessages caps at the last n visible turns", async () => {
    const history = buildHistoryFacet();
    const { messages } = await pluginReadsRecentTurns(history, "conv-1", 2);
    // Newest 2 of the 3 visible rows, oldest→newest.
    expect(messages.map((m) => m.id)).toEqual(["m2", "m5"]);
  });

  test("getMessages paginates with a next cursor when more remain", async () => {
    const history = buildHistoryFacet();
    const page = await history.getMessages("conv-1", { limit: 2 });
    expect(page.messages.map((m) => m.id)).toEqual(["m2", "m5"]);
    expect(page.hasMore).toBe(true);
    // Composite cursor anchors on the page's oldest visible row — timestamp
    // plus the `id` tie-breaker.
    expect(page.nextCursor).toEqual({ beforeTimestamp: 2000, beforeId: "m2" });

    const older = await history.getMessages("conv-1", {
      limit: 2,
      before: page.nextCursor,
    });
    expect(older.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(older.hasMore).toBe(false);
    expect(older.nextCursor).toBeUndefined();
  });

  test("legacy beforeTimestamp-only cursor still walks older pages", async () => {
    const history = buildHistoryFacet();
    // A simple caller that passes only the timestamp (no id) keeps working.
    const older = await history.getMessages("conv-1", {
      limit: 2,
      beforeTimestamp: 2000,
    });
    expect(older.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(older.hasMore).toBe(false);
  });
});

/**
 * Regression: a page boundary that splits messages sharing the same
 * `createdAt` millisecond (imported / forked / rapid same-ms rows) must return
 * ALL rows across the boundary — none skipped, none duplicated. A
 * timestamp-only cursor resumed at `created_at < ts` would drop the older
 * same-ms rows; the composite `(createdAt, id)` cursor fixes this.
 */
describe("history facet — same-millisecond pagination boundary", () => {
  // Three visible rows all at createdAt=7000 plus one older row, so a limit-2
  // page necessarily splits the 7000-ms cluster.
  const SAME_MS_ROWS: SeedRow[] = [
    {
      id: "a-older",
      conversationId: "conv-ms",
      role: "user",
      content: "older",
      createdAt: 6000,
      metadata: null,
      clientMessageId: null,
    },
    {
      id: "b",
      conversationId: "conv-ms",
      role: "user",
      content: "same-ms b",
      createdAt: 7000,
      metadata: null,
      clientMessageId: null,
    },
    {
      id: "c",
      conversationId: "conv-ms",
      role: "assistant",
      content: "same-ms c",
      createdAt: 7000,
      metadata: null,
      clientMessageId: null,
    },
    {
      id: "d",
      conversationId: "conv-ms",
      role: "user",
      content: "same-ms d",
      createdAt: 7000,
      metadata: null,
      clientMessageId: null,
    },
  ];

  test("paginating across a same-ms boundary returns every row exactly once", async () => {
    // Faithful composite-cursor stub scoped to the same-ms fixture.
    getMessagesPaginatedSpy.mockImplementation(
      (
        _conversationId: string,
        limit: number | undefined,
        beforeTimestamp: number | undefined,
        filter?: (row: SeedRow) => boolean,
        beforeId?: string,
      ) => {
        let rows = SAME_MS_ROWS.slice();
        if (beforeTimestamp !== undefined) {
          rows = rows.filter((r) =>
            beforeId === undefined
              ? r.createdAt < beforeTimestamp
              : r.createdAt < beforeTimestamp ||
                (r.createdAt === beforeTimestamp && r.id < beforeId),
          );
        }
        rows.sort(
          (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
        );
        const visible = filter ? rows.filter(filter) : rows;
        if (limit === undefined) {
          visible.reverse();
          return { messages: visible, hasMore: false };
        }
        const page = visible.slice(0, limit).reverse();
        return { messages: page, hasMore: visible.length > limit };
      },
    );

    const history = buildHistoryFacet();
    const seen: string[] = [];
    let cursor = undefined as
      | { beforeTimestamp: number; beforeId: string }
      | undefined;
    // Drain the whole conversation two rows at a time.
    for (let i = 0; i < 10; i++) {
      const page = await history.getMessages("conv-ms", {
        limit: 2,
        before: cursor,
      });
      for (const m of page.messages) seen.push(m.id);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // All four rows returned exactly once (no same-ms row skipped or
    // duplicated), in oldest→newest order.
    expect(seen.sort()).toEqual(["a-older", "b", "c", "d"]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
