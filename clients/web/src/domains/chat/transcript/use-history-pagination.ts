/**
 * TanStack Query wrapper for paginated conversation history.
 *
 * Replaces the manual `conversationCacheRef` LRU map and `loadEpochRef`
 * cancellation token with `useInfiniteQuery`. TanStack Query provides:
 *
 * - **Automatic per-conversation caching** via the query key — no manual
 *   LRU rotation needed.
 * - **Automatic cancellation** via AbortController when the query key
 *   changes (conversation switch) — no epoch-gating needed.
 * - **Stale-while-revalidate** — cached conversations render instantly
 *   while the background refetch picks up any messages added since.
 * - **Pagination** via `fetchNextPage` / `hasNextPage` / `isFetchingNextPage`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation
 */

import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  fetchLatestHistoryPage,
  fetchOlderHistoryPage,
} from "@/domains/chat/api/history";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import { mergeAdjacentAssistantMessages } from "@/domains/chat/utils/message-merge";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";

// ---------------------------------------------------------------------------
// Query key
// ---------------------------------------------------------------------------

export const CONVERSATION_HISTORY_QUERY_KEY = "conversation-history" as const;

export function conversationHistoryQueryKey(
  assistantId: string | null,
  conversationId: string | null,
) {
  return [
    CONVERSATION_HISTORY_QUERY_KEY,
    assistantId ?? "",
    conversationId ?? "",
  ] as const;
}

// Subagent notifications across all loaded pages, oldest-first. Hydration reads
// this rather than only the latest page, so a subagent whose notification is in
// an older page still gets a store entry (otherwise it shows an avatar badge
// with no inline row — e.g. a subagent aborted early in a long conversation).
export function aggregateSubagentNotifications(
  pages: readonly PaginatedHistoryResult[] | undefined,
): NonNullable<PaginatedHistoryResult["subagentNotifications"]> | undefined {
  if (!pages?.length) return undefined;
  const acc: NonNullable<PaginatedHistoryResult["subagentNotifications"]> = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    const ns = pages[i]?.subagentNotifications;
    if (ns?.length) acc.push(...ns);
  }
  return acc.length > 0 ? acc : undefined;
}

// Background-task completions across all loaded pages, oldest-first. Seeding
// reads this rather than only the latest page so a card that completed in an
// older page still gets re-seeded into the store after a daemon restart.
// Dedupe is unnecessary — the store's `seedFromHistory` is idempotent — so we
// just preserve first-seen (oldest-first) order.
export function aggregateBackgroundToolCompletions(
  pages: readonly PaginatedHistoryResult[] | undefined,
): BackgroundTaskEntry[] | undefined {
  if (!pages?.length) return undefined;
  const acc: BackgroundTaskEntry[] = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    const cs = pages[i]?.backgroundToolCompletions;
    if (cs?.length) acc.push(...cs);
  }
  return acc.length > 0 ? acc : undefined;
}

/** The shape `useInfiniteQuery` stores under a conversation-history key. */
export type HistoryCache = InfiniteData<PaginatedHistoryResult>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UseHistoryPaginationParams {
  assistantId: string | null;
  conversationId: string | null;
  enabled: boolean;
}

export interface HistoryPaginationResult {
  /** Flattened messages from all loaded pages, oldest first. */
  messages: DisplayMessage[];
  /** The latest (newest) page result. */
  latestPage: PaginatedHistoryResult | undefined;
  /** Subagent notifications aggregated across all loaded pages, oldest-first. */
  subagentNotifications:
    | NonNullable<PaginatedHistoryResult["subagentNotifications"]>
    | undefined;
  /** Background-task completions aggregated across all loaded pages, oldest-first. */
  backgroundToolCompletions: BackgroundTaskEntry[] | undefined;
  /** First-time load with no cached data available. */
  isLoading: boolean;
  /** At least one successful fetch has completed. */
  isSuccess: boolean;
  /** The query errored. */
  isError: boolean;
  /** The error, if any. */
  error: Error | null;
  /** Older pages are available for infinite scroll. */
  hasMore: boolean;
  /** A fetch for older pages is in progress. */
  isFetchingOlderPages: boolean;
  /** Any fetch (initial, background refetch, or older pages) is active. */
  isFetching: boolean;
  /** Load the next older page. No-op if already fetching or exhausted. */
  fetchOlderPage: () => void;
  /** Invalidate and trigger a background refetch of the latest page. */
  invalidate: () => Promise<void>;
  /** Remove cached data for this conversation (used before a destructive refresh). */
  removeCache: () => void;
  /** Oldest timestamp from the initial (latest) page — reconciliation boundary. */
  latestPageOldestTimestamp: number | null;
  /** Oldest timestamp across all loaded pages — pagination cursor. */
  oldestLoadedTimestamp: number | null;
  /** Monotonic counter that increments on each data update. */
  dataUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const EMPTY_MESSAGES: DisplayMessage[] = [];

export function useHistoryPagination({
  assistantId,
  conversationId,
  enabled,
}: UseHistoryPaginationParams): HistoryPaginationResult {
  const queryClient = useQueryClient();

  const queryKey = useMemo(
    () => conversationHistoryQueryKey(assistantId, conversationId),
    [assistantId, conversationId],
  );

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      if (!assistantId || !conversationId) {
        throw new Error("Missing assistantId or conversationId");
      }
      void signal; // AbortController signal available for future use
      if (pageParam != null) {
        return fetchOlderHistoryPage(
          assistantId,
          conversationId,
          pageParam,
        );
      }
      return fetchLatestHistoryPage(assistantId, conversationId);
    },
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage): number | undefined => {
      if (lastPage.hasMore && lastPage.oldestTimestamp != null) {
        return lastPage.oldestTimestamp;
      }
      return undefined;
    },
    enabled: enabled && !!assistantId && !!conversationId,
    // Always refetch in the background — mirrors the existing
    // "restore from cache then fetch latest and reconcile" pattern.
    staleTime: 0,
    // Keep data for unmounted queries for 5 minutes. With an average
    // of ~10 active conversations, this is the rough equivalent of the
    // old MAX_CACHED_CONVERSATIONS = 10 LRU map.
    gcTime: 5 * 60 * 1000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: shouldRetryDaemonError,
  });

  // Flatten pages into a single chronological array.
  // pages[0] = latest page (newest messages), pages[1] = older, etc.
  // Within each page, messages are already oldest-first.
  // Result: [...oldest-page.messages, ..., ...latest-page.messages]
  //
  // After flattening, fold any adjacent `role: "assistant"` rows that
  // landed on opposite sides of a page boundary back into a single
  // display message. The backend already merges consecutive assistants
  // within a single page (`mergeConsecutiveAssistantMessages` at query
  // time in conversation-routes.ts) — but each page runs that merge in
  // isolation, anchoring on its own oldest row. A long agent loop that
  // straddles N pages comes back as N split client objects, each with a
  // distinct anchor id, which dedupe-by-id can't reconcile. The fold
  // here closes that gap on the read path so a long turn renders as one
  // bubble regardless of how scroll-to-load chunked it.
  const messages = useMemo(() => {
    if (!query.data?.pages?.length) return EMPTY_MESSAGES;
    const { pages } = query.data;
    const flattened: DisplayMessage[] =
      pages.length === 1
        ? pages[0]!.messages
        : (() => {
            const acc: DisplayMessage[] = [];
            for (let i = pages.length - 1; i >= 0; i--) {
              acc.push(...pages[i]!.messages);
            }
            return acc;
          })();
    return mergeAdjacentAssistantMessages(flattened);
  }, [query.data]);

  const subagentNotifications = useMemo(
    () => aggregateSubagentNotifications(query.data?.pages),
    [query.data],
  );

  const backgroundToolCompletions = useMemo(
    () => aggregateBackgroundToolCompletions(query.data?.pages),
    [query.data],
  );

  const latestPage = query.data?.pages[0];
  const oldestPage = query.data?.pages[query.data.pages.length - 1];

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const removeCache = useCallback(() => {
    queryClient.removeQueries({ queryKey });
  }, [queryClient, queryKey]);

  const fetchOlderPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  return {
    messages,
    latestPage,
    subagentNotifications,
    backgroundToolCompletions,
    isLoading: query.isLoading,
    isSuccess: query.isSuccess,
    isError: query.isError,
    error: query.error,
    hasMore: query.hasNextPage ?? false,
    isFetchingOlderPages: query.isFetchingNextPage,
    isFetching: query.isFetching,
    fetchOlderPage,
    invalidate,
    removeCache,
    latestPageOldestTimestamp: latestPage?.oldestTimestamp ?? null,
    oldestLoadedTimestamp: oldestPage?.oldestTimestamp ?? null,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
