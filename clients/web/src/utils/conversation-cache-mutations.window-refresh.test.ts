/**
 * Tests for `refreshConversationListWindows` covering the per-section caches.
 *
 * Sections are paginated like the foreground list: a plain refetch drains
 * every page. The sync path therefore must window-refresh them (one
 * first-page GET per populated cache) rather than invalidate their prefix,
 * and the Pinned section must actually merge, which it would not under the
 * injected-pinned cutoff rule (every one of its rows is pinned).
 *
 * Own file because it mocks the fetcher module, and `mock.module()` is
 * process-global; the pure-function tests stay in
 * `conversation-cache-mutations.test.ts` unmocked.
 */

import { describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import * as fetchers from "@/utils/conversation-list-fetchers";
import type { Conversation } from "@/types/conversation-types";
import {
  backgroundConversationsQueryKey,
  conversationsQueryKey,
  sectionConversationsQueryKey,
  type SectionConversationFilter,
} from "@/utils/conversation-list-fetchers";

type Page = { conversations: Conversation[]; hasMore: boolean };

/** One safe no-op page: empty window, so the merge keeps the cache as-is. */
const NOOP_PAGE: Page = { conversations: [], hasMore: true };

const sectionCalls: SectionConversationFilter[] = [];
let sectionPages: (
  filter: SectionConversationFilter,
) => Page | Promise<Page> = () => NOOP_PAGE;
let foregroundCalls = 0;
let foregroundPage: Page = NOOP_PAGE;

mock.module("@/utils/conversation-list-fetchers", () => ({
  ...fetchers,
  listConversationsFirstPage: async (): Promise<Page> => {
    foregroundCalls += 1;
    return foregroundPage;
  },
  listBackgroundConversationsFirstPage: async (): Promise<Page> => NOOP_PAGE,
  listScheduledConversationsFirstPage: async (): Promise<Page> => NOOP_PAGE,
  listSectionConversationsFirstPage: async (
    _assistantId: string,
    filter: SectionConversationFilter,
  ): Promise<Page> => {
    sectionCalls.push(filter);
    return sectionPages(filter);
  },
}));

const { refreshConversationListWindows } =
  await import("@/utils/conversation-cache-mutations");

const ASSISTANT_ID = "ast-test";
const PINNED: SectionConversationFilter = { groupId: "system:pinned" };
const SLACK: SectionConversationFilter = {
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
  foregroundCalls = 0;
  foregroundPage = NOOP_PAGE;
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function rowsIn(
  client: QueryClient,
  filter: SectionConversationFilter,
): string[] {
  return (
    client
      .getQueryData<
        Conversation[]
      >(sectionConversationsQueryKey(ASSISTANT_ID, filter))
      ?.map((c) => c.conversationId) ?? []
  );
}

describe("refreshConversationListWindows and sections", () => {
  test("each populated section cache gets one first-page fetch with its own filter", async () => {
    const client = reset();
    client.setQueryData(sectionConversationsQueryKey(ASSISTANT_ID, PINNED), [
      conversation({ conversationId: "p1", isPinned: true }),
    ]);
    client.setQueryData(sectionConversationsQueryKey(ASSISTANT_ID, SLACK), [
      conversation({ conversationId: "s1", originChannel: "slack" }),
    ]);

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(sectionCalls).toHaveLength(2);
    expect(sectionCalls).toContainEqual(PINNED);
    expect(sectionCalls).toContainEqual(SLACK);
  });

  test("a section that was never fetched is not fetched by a sync signal", async () => {
    const client = reset();
    client.setQueryData(sectionConversationsQueryKey(ASSISTANT_ID, SLACK), [
      conversation({ conversationId: "s1" }),
    ]);

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(sectionCalls).toEqual([SLACK]);
  });

  test("the Pinned section merges its page even though every row is pinned", async () => {
    const client = reset();
    client.setQueryData(sectionConversationsQueryKey(ASSISTANT_ID, PINNED), [
      // Inside the page's window (between 3000 and 5000) but missing from
      // the page: no longer pinned, must be dropped.
      conversation({ conversationId: "p-stale", lastMessageAt: 4000 }),
      // Below the window: presumed to live on a later page, must survive.
      conversation({ conversationId: "p-older", lastMessageAt: 100 }),
    ]);
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
    client.setQueryData(sectionConversationsQueryKey(ASSISTANT_ID, SLACK), [
      conversation({ conversationId: "s-gone" }),
    ]);
    sectionPages = () => ({
      conversations: [conversation({ conversationId: "s-now" })],
      hasMore: false,
    });

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(rowsIn(client, SLACK)).toEqual(["s-now"]);
  });

  test("static buckets are still refreshed alongside the sections", async () => {
    const client = reset();
    client.setQueryData(conversationsQueryKey(ASSISTANT_ID), [
      conversation({ conversationId: "f1" }),
    ]);
    client.setQueryData(sectionConversationsQueryKey(ASSISTANT_ID, SLACK), [
      conversation({ conversationId: "s1" }),
    ]);

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
    const slackKey = sectionConversationsQueryKey(ASSISTANT_ID, SLACK);
    client.setQueryData(slackKey, [conversation({ conversationId: "s1" })]);

    let resolvePage!: (page: Page) => void;
    sectionPages = () =>
      new Promise<Page>((resolve) => {
        resolvePage = resolve;
      });

    const inFlight = refreshConversationListWindows(client, ASSISTANT_ID);
    // An optimistic move lands while the fetch is out: s1 leaves the
    // section, s2 joins it.
    client.setQueryData(slackKey, [conversation({ conversationId: "s2" })]);
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
    const slackKey = sectionConversationsQueryKey(ASSISTANT_ID, SLACK);
    client.setQueryData(slackKey, [conversation({ conversationId: "s-old" })]);

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
    const failedKey = sectionConversationsQueryKey(ASSISTANT_ID, PINNED);
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
    const pendingKey = sectionConversationsQueryKey(ASSISTANT_ID, SLACK);
    void client
      .prefetchQuery({
        queryKey: pendingKey,
        queryFn: () => new Promise<Conversation[]>(() => {}),
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
    const foregroundKey = conversationsQueryKey(ASSISTANT_ID);
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

  test("an unpopulated bucket is skipped", async () => {
    const client = reset();
    client.setQueryData(backgroundConversationsQueryKey(ASSISTANT_ID), [
      conversation({ conversationId: "b1" }),
    ]);

    await refreshConversationListWindows(client, ASSISTANT_ID);

    expect(foregroundCalls).toBe(0);
    expect(sectionCalls).toEqual([]);
  });
});
