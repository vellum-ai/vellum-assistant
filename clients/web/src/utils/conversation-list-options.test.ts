/**
 * The one options factory behind every conversation list cache: which
 * filters are windowed and which drain, what a drained cache looks like at
 * rest, and that a windowed refetch keeps the scrolled-in window. Run
 * against a real `QueryClient` and the real generated key, with only the
 * daemon transport stubbed, so the queryFn's use of its own context
 * (`client`, `queryKey`) is exercised rather than mocked.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import {
  ARCHIVED_BACKGROUND_FILTER,
  ARCHIVED_FILTER,
  BACKGROUND_FILTER,
  conversationListQueryKey,
  FOREGROUND_FILTER,
} from "@/utils/conversation-list-keys";
import { conversationListOptions } from "@/utils/conversation-list-options";
import {
  listPage,
  type RawConversationFixture,
  rawConversation,
} from "@/utils/conversation-list.test-helper";

const ASSISTANT_ID = "assistant-1";

/**
 * Stub the daemon transport so each list GET resolves the next fixture in
 * order. Returns the captured queries so tests can assert what was sent.
 */
function stubPages(
  fixtures: Array<{ rows: RawConversationFixture[]; hasMore: boolean }>,
): Record<string, unknown>[] {
  const queries: Record<string, unknown>[] = [];
  daemonClient.get = mock(
    async (options: { query?: Record<string, unknown> }) => {
      const index = queries.length;
      queries.push({ ...(options.query ?? {}) });
      const fixture = fixtures[index];
      if (!fixture) {
        throw new Error(`test setup has no fixture for request ${index}`);
      }
      const body = {
        conversations: fixture.rows.map(rawConversation),
        hasMore: fixture.hasMore,
      };
      return {
        data: body,
        error: null,
        response: new Response(JSON.stringify(body), { status: 200 }),
      };
    },
  ) as typeof daemonClient.get;
  return queries;
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const originalGet = daemonClient.get;

afterEach(() => {
  daemonClient.get = originalGet;
});

describe("conversationListOptions", () => {
  test("is keyed by the generated key for its filter", () => {
    const filter = { groupId: "grp-a" };
    expect(conversationListQueryKey(ASSISTANT_ID, filter)).toEqual(
      conversationListOptions(ASSISTANT_ID, filter).queryKey,
    );
    expect(conversationListQueryKey(ASSISTANT_ID, FOREGROUND_FILTER)).toEqual(
      conversationListOptions(ASSISTANT_ID).queryKey,
    );
  });

  test("a bucket drains every page and rests with hasMore false", async () => {
    const queries = stubPages([
      { rows: [{ id: "c-0", lastMessageAt: 10 }], hasMore: true },
      { rows: [{ id: "c-1", lastMessageAt: 20 }], hasMore: false },
    ]);

    const result = await freshClient().fetchQuery(
      conversationListOptions(ASSISTANT_ID, FOREGROUND_FILTER),
    );

    expect(queries.map((q) => q.offset)).toEqual([0, 50]);
    /* Newest first, whatever order the pages arrived in. */
    expect(result.conversations.map((c) => c.conversationId)).toEqual([
      "c-1",
      "c-0",
    ]);
    expect(result.hasMore).toBe(false);
  });

  test("the background bucket drops scheduled rows the umbrella filter returns", async () => {
    stubPages([
      {
        rows: [
          { id: "bg", conversationType: "background", lastMessageAt: 10 },
          { id: "sched", conversationType: "scheduled", lastMessageAt: 20 },
        ],
        hasMore: false,
      },
    ]);

    const result = await freshClient().fetchQuery(
      conversationListOptions(ASSISTANT_ID, BACKGROUND_FILTER),
    );

    expect(result.conversations.map((c) => c.conversationId)).toEqual(["bg"]);
  });

  test("the archived background read keeps scheduled rows", async () => {
    /* The archive view has no archived-scheduled cache; this read is the
       only one that returns archived scheduled runs. */
    stubPages([
      {
        rows: [
          {
            id: "bg",
            conversationType: "background",
            lastMessageAt: 10,
            archivedAt: 10,
          },
          {
            id: "sched",
            conversationType: "scheduled",
            lastMessageAt: 20,
            archivedAt: 20,
          },
        ],
        hasMore: false,
      },
    ]);

    const result = await freshClient().fetchQuery(
      conversationListOptions(ASSISTANT_ID, ARCHIVED_BACKGROUND_FILTER),
    );

    expect(result.conversations.map((c) => c.conversationId)).toEqual([
      "sched",
      "bg",
    ]);
  });

  test("the archived bucket orders by archivedAt, not recency", async () => {
    stubPages([
      {
        rows: [
          { id: "recent-msg", lastMessageAt: 900, archivedAt: 10 },
          { id: "recent-archive", lastMessageAt: 100, archivedAt: 20 },
        ],
        hasMore: false,
      },
    ]);

    const result = await freshClient().fetchQuery(
      conversationListOptions(ASSISTANT_ID, ARCHIVED_FILTER),
    );

    expect(result.conversations.map((c) => c.conversationId)).toEqual([
      "recent-archive",
      "recent-msg",
    ]);
  });

  test("a section fetches one page and keeps server order", async () => {
    const queries = stubPages([
      {
        rows: [
          { id: "older", lastMessageAt: 10 },
          { id: "newer", lastMessageAt: 20 },
        ],
        hasMore: true,
      },
    ]);

    const result = await freshClient().fetchQuery(
      conversationListOptions(ASSISTANT_ID, { groupId: "grp-a" }),
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ groupId: "grp-a", offset: 0 });
    expect(result.conversations.map((c) => c.conversationId)).toEqual([
      "older",
      "newer",
    ]);
    expect(result.hasMore).toBe(true);
  });

  test("a plain refetch of a section keeps the scrolled-in window", async () => {
    /* The queryFn merges the fresh first page over the cached window. A
       bare page-one return here would mean every focus refetch and every
       settle invalidation truncated a scrolled window back to 50 rows
       under the user's scrollbar. */
    const client = freshClient();
    const filter = { groupId: "grp-a" };
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, filter),
      listPage(
        [
          {
            conversationId: "c-top",
            title: "",
            createdAt: 0,
            lastMessageAt: 5000,
          },
          {
            conversationId: "c-scrolled-in",
            title: "",
            createdAt: 0,
            lastMessageAt: 100,
          },
        ],
        true,
      ),
    );
    // The fresh page holds only the window top; the scrolled-in row sorts
    // below the page's cutoff, so the merge must keep it.
    stubPages([
      { rows: [{ id: "c-top", lastMessageAt: 5000 }], hasMore: true },
    ]);

    // staleTime 0: the seeded cache is seconds old, and fetchQuery serves
    // fresh data without running the queryFn, which would pass this test
    // without exercising the merge at all.
    const result = await client.fetchQuery({
      ...conversationListOptions(ASSISTANT_ID, filter),
      staleTime: 0,
    });

    expect(result.conversations.map((c) => c.conversationId)).toEqual([
      "c-top",
      "c-scrolled-in",
    ]);
    expect(result.hasMore).toBe(true);
  });
});
