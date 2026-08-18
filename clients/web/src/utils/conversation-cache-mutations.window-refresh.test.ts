/**
 * Tests for `refreshConversationListWindows` covering the per-section caches,
 * and for `loadMoreConversations`, the windowed caches' append path.
 *
 * A section cache is a window (LUM-2444): the sync path window-refreshes it
 * (one first-page GET per populated cache, merged so load-more pages
 * survive) rather than invalidating its prefix, and the Pinned section must
 * actually merge, which it would not under the injected-pinned cutoff rule
 * (every one of its rows is pinned).
 *
 * Own file because it mocks the fetcher module, and `mock.module()` is
 * process-global; the pure-function tests stay in
 * `conversation-cache-mutations.test.ts` unmocked.
 */

import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import * as fetchers from "@/utils/conversation-list-fetchers";
import type { Conversation } from "@/types/conversation-types";
import { listPage } from "@/utils/conversation-list.test-helper";
import {
  BACKGROUND_FILTER,
  conversationListQueryKey,
  isPinnedInjectedFilter,
  isSectionFilter,
  type ConversationListFilter,
} from "@/utils/conversation-list-keys";

type Page = { conversations: Conversation[]; hasMore: boolean };

/** One safe no-op page: empty window, so the merge keeps the cache as-is. */
const NOOP_PAGE: Page = { conversations: [], hasMore: true };

const sectionCalls: ConversationListFilter[] = [];
let sectionPages: (
  filter: ConversationListFilter,
) => Page | Promise<Page> = () => NOOP_PAGE;
const loadMoreCalls: Array<{
  filter: ConversationListFilter;
  offset: number;
}> = [];
let loadMorePages: (
  filter: ConversationListFilter,
  offset: number,
) => Page | Promise<Page> = () => NOOP_PAGE;
let foregroundCalls = 0;
let foregroundPage: Page = NOOP_PAGE;

mock.module("@/utils/conversation-list-fetchers", (): typeof fetchers => ({
  ...fetchers,
  listConversationsFirstPage: async (
    _assistantId: string,
    filter: ConversationListFilter = {},
  ): Promise<Page> => {
    if (isSectionFilter(filter)) {
      sectionCalls.push(filter);
      return sectionPages(filter);
    }
    if (isPinnedInjectedFilter(filter)) {
      foregroundCalls += 1;
      return foregroundPage;
    }
    return NOOP_PAGE;
  },
  listConversationsPage: async (
    _assistantId: string,
    filter: ConversationListFilter,
    offset: number,
  ): Promise<Page> => {
    loadMoreCalls.push({ filter, offset });
    return loadMorePages(filter, offset);
  },
}));

const { loadMoreConversations, refreshConversationListWindows } =
  await import("@/utils/conversation-cache-mutations");

const ASSISTANT_ID = "ast-test";
const PINNED: ConversationListFilter = { groupId: "system:pinned" };
const SLACK: ConversationListFilter = {
  groupId: "system:all",
  originChannel: "slack",
};

function conversation(
  overrides: Partial<Conversation> & { conversationId: string },
): Conversation {
  return { lastMessageAt: 2000, ...overrides };
}

function reset(): QueryClient {
  sectionCalls.length = 0;
  sectionPages = () => NOOP_PAGE;
  loadMoreCalls.length = 0;
  loadMorePages = () => NOOP_PAGE;
  foregroundCalls = 0;
  foregroundPage = NOOP_PAGE;
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function rowsIn(client: QueryClient, filter: ConversationListFilter): string[] {
  return (
    client
      .getQueryData<Page>(conversationListQueryKey(ASSISTANT_ID, filter))
      ?.conversations.map((c) => c.conversationId) ?? []
  );
}

describe("refreshConversationListWindows and sections", () => {
  test("each populated section cache gets one first-page fetch with its own filter", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, PINNED),
      listPage([conversation({ conversationId: "p1", isPinned: true })]),
    );
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
      listPage([
        conversation({ conversationId: "s1", originChannel: "slack" }),
      ]),
    );

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(sectionCalls).toHaveLength(2);
    expect(sectionCalls).toContainEqual(PINNED);
    expect(sectionCalls).toContainEqual(SLACK);
  });

  test("a section that was never fetched is not fetched by a sync signal", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
      listPage([conversation({ conversationId: "s1" })]),
    );

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(sectionCalls).toEqual([SLACK]);
  });

  test("the Pinned section merges its page even though every row is pinned", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, PINNED),
      listPage([
        // Inside the page's window (between 3000 and 5000) but missing from
        // the page: no longer pinned, must be dropped.
        conversation({ conversationId: "p-stale", lastMessageAt: 4000 }),
        // Below the window: presumed to live on a later page, must survive.
        conversation({ conversationId: "p-older", lastMessageAt: 100 }),
      ]),
    );
    sectionPages = () => ({
      conversations: [
        conversation({
          conversationId: "p-new",
          lastMessageAt: 5000,
          isPinned: true,
        }),
        conversation({
          conversationId: "p-mid",
          lastMessageAt: 3000,
          isPinned: true,
        }),
      ],
      hasMore: true,
    });

    await refreshConversationListWindows(client, ASSISTANT_ID);

    // Under the injected-pinned cutoff rule this all-pinned page would have
    // formed no window at all: nothing merged, p-stale surviving every sync
    // signal.
    expect(rowsIn(client, PINNED)).toEqual(["p-new", "p-mid", "p-older"]);
  });

  test("a complete section page replaces the cache", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
      listPage([conversation({ conversationId: "s-gone" })]),
    );
    sectionPages = () => ({
      conversations: [conversation({ conversationId: "s-now" })],
      hasMore: false,
    });

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(rowsIn(client, SLACK)).toEqual(["s-now"]);
  });

  test("static buckets are still refreshed alongside the sections", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID),
      listPage([conversation({ conversationId: "f1" })]),
    );
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
      listPage([conversation({ conversationId: "s1" })]),
    );

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(foregroundCalls).toBe(1);
    expect(sectionCalls).toEqual([SLACK]);
  });

  test("a response that lost the race to a newer cache write is dropped", async () => {
    /* The window fetch runs outside TanStack, so an optimistic placement's
       `cancelQueries` cannot cancel it. A page fetched before a pin landing
       after it would resurrect the old placement; the guard drops any
       response the cache was written past. */
    const client = reset();
    const slackKey = conversationListQueryKey(ASSISTANT_ID, SLACK);
    client.setQueryData(
      slackKey,
      listPage([conversation({ conversationId: "s1" })]),
    );

    let resolvePage!: (page: Page) => void;
    sectionPages = () =>
      new Promise<Page>((resolve) => {
        resolvePage = resolve;
      });

    const inFlight = refreshConversationListWindows(client, ASSISTANT_ID);
    // An optimistic move lands while the fetch is out: s1 leaves the
    // section, s2 joins it.
    client.setQueryData(
      slackKey,
      listPage([conversation({ conversationId: "s2" })]),
    );
    // The response arrives carrying the pre-move server state.
    resolvePage({
      conversations: [conversation({ conversationId: "s1" })],
      hasMore: false,
    });
    await inFlight;

    expect(rowsIn(client, SLACK)).toEqual(["s2"]);
  });

  test("a slower refresh cannot overwrite a faster newer one", async () => {
    const client = reset();
    const slackKey = conversationListQueryKey(ASSISTANT_ID, SLACK);
    client.setQueryData(
      slackKey,
      listPage([conversation({ conversationId: "s-old" })]),
    );

    // Refresh A: response deferred.
    let resolveA!: (page: Page) => void;
    sectionPages = () =>
      new Promise<Page>((resolve) => {
        resolveA = resolve;
      });
    const refreshA = refreshConversationListWindows(client, ASSISTANT_ID);

    // Refresh B: resolves immediately with newer server state and commits.
    sectionPages = () => ({
      conversations: [conversation({ conversationId: "s-newer" })],
      hasMore: false,
    });
    await refreshConversationListWindows(client, ASSISTANT_ID);
    expect(rowsIn(client, SLACK)).toEqual(["s-newer"]);

    // A's older response arrives last and must not win.
    resolveA({
      conversations: [conversation({ conversationId: "s-old" })],
      hasMore: false,
    });
    await refreshA;

    expect(rowsIn(client, SLACK)).toEqual(["s-newer"]);
  });

  test("a section whose first fetch failed is invalidated for retry", async () => {
    /* A tracked query holding no data cannot be merged into, and skipping it
       strands the section on its derived fallback forever: the sync signal
       is its only retry path now that the prefix invalidation is gone. */
    const client = reset();
    const failedKey = conversationListQueryKey(ASSISTANT_ID, PINNED);
    await client
      .prefetchQuery({
        queryKey: failedKey,
        queryFn: () => Promise.reject(new Error("first fetch failed")),
        retry: false,
      })
      .catch(() => {});
    expect(client.getQueryData(failedKey)).toBeUndefined();

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(client.getQueryState(failedKey)?.isInvalidated).toBe(true);
    // Invalidation re-drives the query's own fetch; the window fetcher must
    // not also fire for a cache it cannot merge into.
    expect(sectionCalls).toEqual([]);
  });

  test("a section mid-first-fetch is left alone", async () => {
    /* Invalidating an in-flight query cancels and restarts it, so a burst
       of sync signals arriving faster than a first load completes would
       keep that load from ever finishing. */
    const client = reset();
    const pendingKey = conversationListQueryKey(ASSISTANT_ID, SLACK);
    void client
      .prefetchQuery({
        queryKey: pendingKey,
        queryFn: () => new Promise<Page>(() => {}),
      })
      .catch(() => {});

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(client.getQueryState(pendingKey)?.isInvalidated).toBe(false);
    expect(sectionCalls).toEqual([]);
  });

  test("a bucket whose first fetch failed is invalidated for retry", async () => {
    // Same recovery contract as the sections; the bucket path had the same
    // hole (a failed first fetch was skipped, not retried).
    const client = reset();
    const foregroundKey = conversationListQueryKey(ASSISTANT_ID);
    await client
      .prefetchQuery({
        queryKey: foregroundKey,
        queryFn: () => Promise.reject(new Error("first fetch failed")),
        retry: false,
      })
      .catch(() => {});

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(client.getQueryState(foregroundKey)?.isInvalidated).toBe(true);
    expect(foregroundCalls).toBe(0);
  });

  test("a failed bucket's retry invalidates that bucket alone", async () => {
    /* The foreground key's filter is the empty object, and a key used as a
       partial filter matches every key whose query extends it, so an inexact
       invalidation here would refetch every section and re-drain every other
       bucket on each sync signal while the foreground list is errored. */
    const client = reset();
    const foregroundKey = conversationListQueryKey(ASSISTANT_ID);
    await client
      .prefetchQuery({
        queryKey: foregroundKey,
        queryFn: () => Promise.reject(new Error("first fetch failed")),
        retry: false,
      })
      .catch(() => {});
    const pinnedKey = conversationListQueryKey(ASSISTANT_ID, PINNED);
    client.setQueryData(
      pinnedKey,
      listPage([conversation({ conversationId: "p1", isPinned: true })]),
    );
    const backgroundKey = conversationListQueryKey(
      ASSISTANT_ID,
      BACKGROUND_FILTER,
    );
    client.setQueryData(
      backgroundKey,
      listPage([conversation({ conversationId: "b1" })]),
    );

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(client.getQueryState(foregroundKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(pinnedKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(backgroundKey)?.isInvalidated).toBe(false);
  });

  test("an unpopulated bucket is skipped", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, BACKGROUND_FILTER),
      listPage([conversation({ conversationId: "b1" })]),
    );

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(foregroundCalls).toBe(0);
    expect(sectionCalls).toEqual([]);
  });
});

describe("loadMoreConversations", () => {
  test("appends the next page at the cache's current row count", async () => {
    const client = reset();
    const slackKey = conversationListQueryKey(ASSISTANT_ID, SLACK);
    client.setQueryData(
      slackKey,
      listPage(
        [
          conversation({ conversationId: "s1", lastMessageAt: 5000 }),
          conversation({ conversationId: "s2", lastMessageAt: 4000 }),
        ],
        true,
      ),
    );
    loadMorePages = () => ({
      conversations: [
        conversation({ conversationId: "s3", lastMessageAt: 3000 }),
      ],
      hasMore: false,
    });

    await loadMoreConversations(client, ASSISTANT_ID, SLACK);

    expect(loadMoreCalls).toEqual([{ filter: SLACK, offset: 2 }]);
    expect(rowsIn(client, SLACK)).toEqual(["s1", "s2", "s3"]);
    expect(client.getQueryData<Page>(slackKey)?.hasMore).toBe(false);
  });

  test("dedupes rows the cache already holds", async () => {
    /* Offset pagination under concurrent server-side changes can hand back
       a row from the previous page; appending it again would render the
       conversation twice in one section. */
    const client = reset();
    const slackKey = conversationListQueryKey(ASSISTANT_ID, SLACK);
    client.setQueryData(
      slackKey,
      listPage([conversation({ conversationId: "s1" })], true),
    );
    loadMorePages = () => ({
      conversations: [
        conversation({ conversationId: "s1" }),
        conversation({ conversationId: "s2" }),
      ],
      hasMore: true,
    });

    await loadMoreConversations(client, ASSISTANT_ID, SLACK);

    expect(rowsIn(client, SLACK)).toEqual(["s1", "s2"]);
  });

  test("a complete or unfetched cache is a no-op without a request", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
      listPage([conversation({ conversationId: "s1" })]),
    );

    await loadMoreConversations(client, ASSISTANT_ID, SLACK);
    await loadMoreConversations(client, ASSISTANT_ID, PINNED);

    expect(loadMoreCalls).toEqual([]);
  });

  test("one request per section while in flight", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
      listPage([conversation({ conversationId: "s1" })], true),
    );
    let resolvePage!: (page: Page) => void;
    loadMorePages = () =>
      new Promise<Page>((resolve) => {
        resolvePage = resolve;
      });

    const first = loadMoreConversations(client, ASSISTANT_ID, SLACK);
    // The sentinel re-fires while the request is out; the guard holds.
    const second = loadMoreConversations(client, ASSISTANT_ID, SLACK);
    resolvePage({
      conversations: [conversation({ conversationId: "s2" })],
      hasMore: false,
    });
    await Promise.all([first, second]);

    expect(loadMoreCalls).toHaveLength(1);
    expect(rowsIn(client, SLACK)).toEqual(["s1", "s2"]);
  });

  test("a response that lost the race to a newer cache write is dropped", async () => {
    /* Same identity guard as the window refresh: the offset was computed
       against rows that no longer exist, so appending would misplace the
       page. The sentinel is still visible and re-fires against the new
       cache. */
    const client = reset();
    const slackKey = conversationListQueryKey(ASSISTANT_ID, SLACK);
    client.setQueryData(
      slackKey,
      listPage([conversation({ conversationId: "s1" })], true),
    );
    let resolvePage!: (page: Page) => void;
    loadMorePages = () =>
      new Promise<Page>((resolve) => {
        resolvePage = resolve;
      });

    const inFlight = loadMoreConversations(client, ASSISTANT_ID, SLACK);
    client.setQueryData(
      slackKey,
      listPage([conversation({ conversationId: "s2" })], true),
    );
    resolvePage({
      conversations: [conversation({ conversationId: "s3" })],
      hasMore: false,
    });
    await inFlight;

    expect(rowsIn(client, SLACK)).toEqual(["s2"]);
    // The write that outran the response keeps its own hasMore.
    expect(client.getQueryData<Page>(slackKey)?.hasMore).toBe(true);
  });

  test("the guard clears after a failed fetch so the next attempt retries", async () => {
    const client = reset();
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
      listPage([conversation({ conversationId: "s1" })], true),
    );
    loadMorePages = () => Promise.reject(new Error("network down"));

    await expect(
      loadMoreConversations(client, ASSISTANT_ID, SLACK),
    ).rejects.toThrow("network down");

    loadMorePages = () => ({
      conversations: [conversation({ conversationId: "s2" })],
      hasMore: false,
    });
    await loadMoreConversations(client, ASSISTANT_ID, SLACK);

    expect(rowsIn(client, SLACK)).toEqual(["s1", "s2"]);
  });
});
