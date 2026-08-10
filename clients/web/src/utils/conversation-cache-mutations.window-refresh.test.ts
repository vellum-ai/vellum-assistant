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
let sectionPages: (filter: SectionConversationFilter) => Page = () => NOOP_PAGE;
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
      conversation({ conversationId: "p-stale", lastMessageAt: 4000 }),
    ]);
    sectionPages = () => ({
      conversations: [
        conversation({
          conversationId: "p-new",
          lastMessageAt: 5000,
          isPinned: true,
        }),
      ],
      hasMore: true,
    });

    await refreshConversationListWindows(client, ASSISTANT_ID);

    // Under the injected-pinned cutoff rule this page would have merged
    // nothing (no non-pinned rows to form a window) and p-stale would
    // survive a sync signal forever.
    expect(rowsIn(client, PINNED)).toEqual(["p-new"]);
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
