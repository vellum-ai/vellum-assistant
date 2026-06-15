/**
 * Query options factories for conversation lists (foreground, background,
 * scheduled, archived).
 *
 * The foreground list uses `useInfiniteQuery` with cursor-based pagination
 * (offset/limit), loading one page at a time on demand. Background, scheduled,
 * and archived lists use a standard `useQuery` that fetches all rows (these
 * are lazy-loaded on user action and typically small).
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
 */

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { captureError } from "@/lib/sentry/capture-error";
import { conversationsGet } from "@/generated/daemon/sdk.gen";
import {
  conversationsGetInfiniteQueryKey,
  conversationsUnreadcountGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  ConversationsGetData,
  ConversationsUnreadcountGetData,
} from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import {
  archivedConversationsQueryKey,
  backgroundConversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import type { Conversation } from "@/types/conversation-types";
import { isScheduledConversation } from "@/utils/conversation-predicates";
import { toConversation } from "@/utils/conversation-transforms";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONVERSATION_LIST_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Shared sort comparator
// ---------------------------------------------------------------------------

/** Sort conversations descending by a timestamp field (newest first). */
function byTimestampDesc(
  key: "lastMessageAt" | "archivedAt",
): (a: Conversation, b: Conversation) => number {
  return (a, b) => (b[key] ?? 0) - (a[key] ?? 0);
}

// ---------------------------------------------------------------------------
// Foreground conversation list — infinite query
// ---------------------------------------------------------------------------

/**
 * A single page of the foreground conversation list, stored in the infinite
 * query cache. The `conversations` field holds domain-typed `Conversation[]`
 * (already transformed from the daemon's raw response) so optimistic cache
 * mutations can operate directly on `Conversation` objects.
 */
export interface ConversationPage {
  conversations: Conversation[];
  hasMore: boolean;
  nextOffset: number;
}

const QUERY_STALE_TIME_MS = 30_000;

/**
 * Infinite query options for the foreground conversation list. Loads one page
 * (50 items) initially and fetches more on demand via `fetchNextPage()`.
 *
 * The queryFn transforms raw daemon responses to `Conversation[]` at fetch
 * time so the cache stores domain types directly — enabling optimistic
 * updates without raw↔domain conversion overhead.
 */
export function conversationListInfiniteOptions(assistantId: string) {
  return infiniteQueryOptions({
    queryKey: conversationListInfiniteQueryKey(assistantId),
    queryFn: async ({ pageParam, signal }): Promise<ConversationPage> => {
      const { data, error, response } = await conversationsGet({
        path: { assistant_id: assistantId },
        query: { limit: CONVERSATION_LIST_PAGE_SIZE, offset: pageParam },
        signal,
        throwOnError: false,
      });
      assertHasResponse(response, error, "Failed to list conversations.");
      if (!response.ok) {
        const msg = extractErrorMessage(error, response, "Failed to list conversations.");
        throw new ApiError(response.status, msg);
      }
      return {
        conversations: (data?.conversations ?? []).map(toConversation),
        hasMore: data?.hasMore ?? false,
        nextOffset: data?.nextOffset ?? 0,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage): number | undefined =>
      lastPage.hasMore ? lastPage.nextOffset : undefined,
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Build the infinite query key for the foreground conversation list.
 * Exported so imperative callers (cache mutations, sync handlers) can
 * target the same cache entry.
 */
export function conversationListInfiniteQueryKey(assistantId: string | null) {
  const opts: Options<ConversationsGetData> = {
    path: { assistant_id: assistantId ?? "" },
    query: { limit: CONVERSATION_LIST_PAGE_SIZE },
  };
  return conversationsGetInfiniteQueryKey(opts);
}

/**
 * Flatten infinite query pages into a single `Conversation[]`. Used by
 * hooks and imperative cache readers that need the complete loaded list.
 */
export function flattenConversationPages(
  pages: ConversationPage[],
): Conversation[] {
  return pages.flatMap((page) => page.conversations);
}

/**
 * Build the query key for the unread conversation count endpoint.
 * Used by `invalidateConversationQueries` and optimistic updaters.
 */
export function unreadCountQueryKey(assistantId: string | null) {
  const opts: Options<ConversationsUnreadcountGetData> = {
    path: { assistant_id: assistantId ?? "" },
  };
  return conversationsUnreadcountGetQueryKey(opts);
}

// ---------------------------------------------------------------------------
// Background / Scheduled / Archived — standard queries (lazy, small lists)
//
// These lists are lazily loaded only when the user reveals the corresponding
// sidebar section. They remain as exhaustive fetchers because:
// 1. They're small (typically 10–50 items)
// 2. They never run on the initial render path
// 3. The sidebar needs the full list for grouping by source/job
// ---------------------------------------------------------------------------

type FetchConversationListOptions = {
  conversationType?: "background" | "scheduled";
  archiveStatus?: "active" | "archived" | "all";
};

/** One page of a conversation list plus whether more pages exist. */
export type ConversationListPage = {
  conversations: Conversation[];
  hasMore: boolean;
};

async function fetchConversationListPage(
  assistantId: string,
  offset: number,
  options: FetchConversationListOptions = {},
): Promise<ConversationListPage> {
  const { conversationType, archiveStatus } = options;
  const { data, error, response } = await conversationsGet({
    path: { assistant_id: assistantId },
    query: {
      limit: CONVERSATION_LIST_PAGE_SIZE,
      offset,
      ...(conversationType ? { conversationType } : {}),
      ...(archiveStatus ? { archiveStatus } : {}),
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list conversations.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to list conversations.");
    throw new ApiError(response.status, msg);
  }

  return {
    conversations: (data?.conversations ?? []).map(toConversation),
    hasMore: data?.hasMore ?? false,
  };
}

/**
 * Fetch all pages of a conversation list. Used only for background, scheduled,
 * and archived lists where the full list is needed and the count is small.
 */
async function fetchAllPages(
  assistantId: string,
  options: FetchConversationListOptions = {},
): Promise<Conversation[]> {
  const all: Conversation[] = [];
  const maxPages = 200;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * CONVERSATION_LIST_PAGE_SIZE;
    const { conversations, hasMore } = await fetchConversationListPage(
      assistantId,
      offset,
      options,
    );
    all.push(...conversations);

    if (!hasMore) break;
    if (conversations.length === 0) break;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Public fetchers (background, scheduled, archived)
// ---------------------------------------------------------------------------

async function listBackgroundConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const background = await fetchAllPages(assistantId, {
    conversationType: "background",
  });
  return background
    .filter((c) => !isScheduledConversation(c))
    .sort(byTimestampDesc("lastMessageAt"));
}

async function listScheduledConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const scheduled = await fetchAllPages(assistantId, {
    conversationType: "scheduled",
  });
  return [...scheduled].sort(byTimestampDesc("lastMessageAt"));
}

async function listArchivedConversations(
  assistantId: string,
): Promise<Conversation[]> {
  return fetchMergedConversationList(assistantId, "archived", "archivedAt");
}

/**
 * Fetch archived conversations — foreground and background buckets in parallel,
 * deduplicated by conversationId, and sorted.
 */
async function fetchMergedConversationList(
  assistantId: string,
  archiveStatus: "active" | "archived" = "active",
  sortKey: "lastMessageAt" | "archivedAt" = "lastMessageAt",
): Promise<Conversation[]> {
  const opts: FetchConversationListOptions = archiveStatus === "active" ? {} : { archiveStatus };
  const bgOpts: FetchConversationListOptions = { ...opts, conversationType: "background" };

  const [foregroundResult, backgroundResult] = await Promise.allSettled([
    fetchAllPages(assistantId, opts),
    fetchAllPages(assistantId, bgOpts),
  ]);

  if (foregroundResult.status === "rejected") {
    throw foregroundResult.reason;
  }

  const foreground = foregroundResult.value;
  let background: Conversation[] = [];
  if (backgroundResult.status === "fulfilled") {
    background = backgroundResult.value;
  } else {
    captureError(backgroundResult.reason, {
      context: `fetchMergedConversationList.background(${archiveStatus})`,
      level: "warning",
      extra: { assistantId },
    });
  }

  const seen = new Set<string>();
  const conversations: Conversation[] = [];
  for (const conversation of [...foreground, ...background]) {
    if (seen.has(conversation.conversationId)) continue;
    seen.add(conversation.conversationId);
    conversations.push(conversation);
  }

  conversations.sort(byTimestampDesc(sortKey));
  return conversations;
}

// ---------------------------------------------------------------------------
// First-page fetchers
//
// Single-request variants of the list fetchers above, used by the
// sync_changed consumer to refresh the top of a cached list without
// re-draining every page. At thousands of conversations the full drain is
// hundreds of sequential GETs, which exhausts the daemon's per-client
// rate-limit budget when sync events arrive continuously during an active
// turn. Each returns the bucket's newest rows (one page, already filtered
// and sorted with the same semantics as its full-list counterpart) plus
// `hasMore` so callers can tell a complete list from a window.
// ---------------------------------------------------------------------------

/** First page of the background conversation list. */
export async function listBackgroundConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0, {
    conversationType: "background",
  });
  return {
    ...page,
    conversations: page.conversations
      .filter((c) => !isScheduledConversation(c))
      .sort(byTimestampDesc("lastMessageAt")),
  };
}

/** First page of the scheduled conversation list. */
export async function listScheduledConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0, {
    conversationType: "scheduled",
  });
  return {
    ...page,
    conversations: [...page.conversations].sort(byTimestampDesc("lastMessageAt")),
  };
}

// ---------------------------------------------------------------------------
// queryOptions factories (background, scheduled, archived)
// ---------------------------------------------------------------------------

export function backgroundConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: backgroundConversationsQueryKey(assistantId),
    queryFn: () => listBackgroundConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

export function scheduledConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: scheduledConversationsQueryKey(assistantId),
    queryFn: () => listScheduledConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

export function archivedConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: archivedConversationsQueryKey(assistantId),
    queryFn: () => listArchivedConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}
