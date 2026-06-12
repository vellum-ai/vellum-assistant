/**
 * TanStack Query hooks for conversations and conversation groups.
 *
 * The foreground list uses `useInfiniteQuery` with cursor-based pagination
 * (offset/limit). One page (50 items) loads on mount; additional pages load
 * on demand via `fetchNextPage()`. Background, scheduled, and archived lists
 * use standard `useQuery` (they're lazily loaded and small).
 *
 * Cache mutation helpers live in `utils/conversation-cache-mutations.ts`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
 */

import { useCallback, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  conversationsUnreadcountGetOptions,
  groupsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  ConversationsUnreadcountGetData,
  GroupsGetData,
} from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import {
  backgroundConversationListOptions,
  conversationListInfiniteOptions,
  flattenConversationPages,
  scheduledConversationListOptions,
  archivedConversationListOptions,
} from "@/utils/conversation-list-fetchers";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Stable empty references so consumers don't churn on `??` fallback.
const EMPTY_CONVERSATIONS: Conversation[] = [];
const EMPTY_GROUPS: ConversationGroup[] = [];

/**
 * Subscribe to the foreground conversation list for the given assistant.
 *
 * Loads one page (50 conversations) on mount via `useInfiniteQuery`. The
 * sidebar renders the first few immediately; additional pages load on demand
 * when the user clicks "show more" (via `fetchNextPage()`).
 *
 * Returns a flat `Conversation[]` (all loaded pages flattened) so existing
 * consumers (sidebar grouping, attention tracking, command palette) work
 * without modification.
 *
 * `fetchNextPage` and `hasNextPage` are exposed for the sidebar's "show
 * more" button to trigger on-demand loading when local data is exhausted.
 */
export function useConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): {
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
} {
  const isOrgReady = useIsOrgReady();
  const query = useInfiniteQuery({
    ...conversationListInfiniteOptions(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
  });

  const conversations = useMemo(
    () => (query.data ? flattenConversationPages(query.data.pages) : EMPTY_CONVERSATIONS),
    [query.data],
  );

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  const fetchNextPage = useCallback(() => {
    void query.fetchNextPage();
  }, [query.fetchNextPage]);

  return {
    conversations,
    isLoading: query.isLoading,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch,
    fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

/**
 * Subscribe to the server-authoritative unread conversation count.
 *
 * Returns the count of foreground conversations with unseen assistant
 * messages (excludes background, scheduled, and archived). Used by the
 * dock badge instead of deriving the count client-side from the full list.
 */
export function useUnreadConversationCountQuery(
  assistantId: string | null,
  enabled: boolean = true,
): { count: number; isLoading: boolean } {
  const isOrgReady = useIsOrgReady();
  const opts: Options<ConversationsUnreadcountGetData> = {
    path: { assistant_id: assistantId ?? "" },
  };
  const query = useQuery({
    ...conversationsUnreadcountGetOptions(opts),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
    // Poll frequently so the badge stays up-to-date without relying on
    // having the full conversation list loaded.
    refetchInterval: 30_000,
  });
  return {
    count: query.data?.count ?? 0,
    isLoading: query.isLoading,
  };
}

/**
 * Subscribe to the background conversation list for the given assistant.
 * Cached separately from the foreground list under
 * `backgroundConversationsQueryKey`.
 *
 * `enabled` gates the network fetch on whether the user has revealed the
 * Background sidebar section. Passing `enabled: false` keeps the observer
 * subscribed to cache updates without firing a request — used by attention
 * tracking so it reflects background rows once the sidebar has loaded them,
 * but never triggers the fetch itself.
 */
export function useBackgroundConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): {
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
} {
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...backgroundConversationListOptions(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
  });
  return {
    conversations: query.data ?? EMPTY_CONVERSATIONS,
    isLoading: query.isLoading,
    isPending: query.isPending,
  };
}

/**
 * Subscribe to the scheduled conversation list for the given assistant.
 * Cached separately under `scheduledConversationsQueryKey` so revealing the
 * Scheduled section fetches only scheduled jobs, independently of the
 * background backlog.
 *
 * `enabled` gates the network fetch on whether the user has revealed the
 * Scheduled sidebar section.
 */
export function useScheduledConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): {
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
} {
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...scheduledConversationListOptions(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
  });
  return {
    conversations: query.data ?? EMPTY_CONVERSATIONS,
    isLoading: query.isLoading,
    isPending: query.isPending,
  };
}

/**
 * Subscribe to the archived conversation list for the given assistant. The
 * cache lives under a separate query key (`archivedConversationsQueryKey`)
 * so that mutations to the active list don't refetch the archive view and
 * vice versa.
 */
export function useArchivedConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): {
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...archivedConversationListOptions(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
  });
  return {
    conversations: query.data ?? EMPTY_CONVERSATIONS,
    isLoading: query.isLoading,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Subscribe to the conversation groups (folders) for the given assistant.
 * Mounted with `enabled: false` when the `conversationGroupsUI` flag is
 * disabled so it does not fire a network request.
 */
export function useConversationGroupsQuery(
  assistantId: string | null,
  enabled: boolean = true,
): { conversationGroups: ConversationGroup[]; isLoading: boolean } {
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...groupsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    } as Options<GroupsGetData>),
    select: (data) => data.groups,
    enabled: enabled && Boolean(assistantId) && isOrgReady,
    staleTime: 30_000,
  });
  return {
    conversationGroups: query.data ?? EMPTY_GROUPS,
    isLoading: query.isLoading,
  };
}
