/**
 * TanStack Query hooks for conversations and conversation groups.
 *
 * Conversations and conversation groups are server-derived data and live
 * in TanStack Query per `clients/web/docs/STATE_MANAGEMENT.md`. The
 * companion `conversation-store.ts` keeps only the client-side slice —
 * active/editing key, processing/attention sets, and snapshots.
 *
 * Each hook spreads a `queryOptions` factory (`conversationListOptions` in
 * `utils/conversation-list-options.ts` for the list caches; the fetchers
 * module for the sidebar's other reads) and adds runtime concerns
 * (`enabled` gating via `useCanQueryDaemon()`, `select` transforms). This
 * co-locates `queryKey` + `queryFn` + `staleTime` in one place so they
 * can be reused across hooks, prefetches, and imperative cache reads.
 *
 * The list hooks are one hook, {@link useListQuery}, under the names the
 * consumers read: every list cache is `conversationListOptions` with a
 * different filter, and the named hooks exist for the consumers that still
 * read the four buckets rather than a section. They go with those consumers.
 *
 * Cache mutation helpers live in `utils/conversation-cache-mutations.ts`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
 * - https://tanstack.com/query/latest/docs/framework/react/guides/queries
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import { useMemo } from "react";
import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";

import { groupsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type { GroupsGetData } from "@/generated/daemon/types.gen";
import { useAssistantIsServing } from "@/assistant/operational-status";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { mergeConversationLists } from "@/utils/conversation-cache";
import {
  sidebarSectionsOptions,
  unreadConversationCountOptions,
} from "@/utils/conversation-list-fetchers";
import type {
  ConversationListPage,
  SidebarIndexSection,
} from "@/utils/conversation-list-fetchers";
import {
  ARCHIVED_BACKGROUND_FILTER,
  ARCHIVED_FILTER,
  BACKGROUND_FILTER,
  type ConversationListFilter,
  FOREGROUND_FILTER,
  SCHEDULED_FILTER,
} from "@/utils/conversation-list-keys";
import { conversationListOptions } from "@/utils/conversation-list-options";
import { byTimestampDesc } from "@/utils/conversation-order";
import { countUnreadConversationsInList } from "@/utils/conversation-predicates";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Stable empty references so consumers don't churn on `??` fallback.
const EMPTY_CONVERSATIONS: Conversation[] = [];
const EMPTY_GROUPS: ConversationGroup[] = [];

/**
 * The preconditions every daemon-backed query in this module shares: the org
 * header the interceptor needs is available, and the assistant's pod is not
 * known to be down.
 *
 * Applied inside each hook rather than asked of callers, because these queries
 * share their query keys across many call sites and TanStack Query fetches
 * when *any* observer is enabled. A precondition enforced at one call site is
 * a precondition some other mount defeats, so the only place it holds is here.
 *
 * The pod half matters most while an assistant is waking: the daemon 503s
 * every request through that window, and a list query that spends its retry
 * budget there gives up for good. Gating instead of retrying also supplies the
 * recovery edge, since TanStack Query refetches when `enabled` flips back to
 * true. See {@link useAssistantIsServing}.
 *
 * Exported for the one imperative daemon read that shares the queries'
 * preconditions (the cold-boot landing lookup in `use-conversation-loader`),
 * so the gate has one definition.
 */
export function useCanQueryDaemon(assistantId: string | null): boolean {
  const isOrgReady = useIsOrgReady();
  const isServing = useAssistantIsServing(assistantId);
  return isOrgReady && isServing;
}

/** What every list hook returns. */
export interface ConversationListQueryResult {
  /** Empty until the query resolves, so consumers render without null checks. */
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  /**
   * Whether the query has ever resolved; survives a failed refetch. What a
   * consumer branches on to decide whether to trust `conversations`:
   * `isError` is not its complement, since React Query keeps the last
   * successful data when a later refetch fails, and treating an errored
   * query as unusable would swap real rows for a worse list. `hasData` is
   * false in exactly the cases with nothing to show: never fetched, still
   * pending, or failed before it ever succeeded.
   */
  hasData: boolean;
  /**
   * Whether the server holds rows past this window (LUM-2444). `false`
   * until the query resolves, so nothing offers a load-more for a list that
   * has not answered once, and always `false` for a drained bucket.
   */
  hasMore: boolean;
  refetch: () => void;
}

type ListQueryOptions = ReturnType<typeof conversationListOptions> & {
  enabled: boolean;
};

/**
 * What a list hook returns when it has no query to observe: the same shape a
 * never-enabled query reports (pending, not loading, nothing to show), so a
 * consumer branches the same way in both cases.
 */
const NO_QUERY: ConversationListQueryResult = {
  conversations: EMPTY_CONVERSATIONS,
  isLoading: false,
  isPending: true,
  isError: false,
  error: null,
  hasData: false,
  hasMore: false,
  refetch: () => {},
};

/**
 * Subscribe to the list cache `filter` names, or to nothing when `filter` is
 * `null`.
 *
 * `null` mounts no query at all (`useQueries` with an empty list), which is
 * what a section without a server filter needs: every filter names a real
 * cache under the generated key, the empty filter included, so there is no
 * placeholder key a disabled observer could sit on without subscribing to
 * someone's data.
 *
 * `enabled` gates the network fetch; passing `false` keeps the observer
 * subscribed to cache updates without firing a request (attention tracking
 * reads the background and scheduled buckets that way: it reflects their
 * rows once the sidebar loads them, but never triggers the fetch itself).
 *
 * `isError`, `error`, and `refetch` let a chat surface render a visible
 * error state when the list fails, most notably for self-hosted assistants,
 * where a missing actor-token JWT surfaces as a gateway 401 that has to
 * terminate the loading spinner with an actionable retry instead of
 * silently keeping the sidebar empty.
 */
function useListQuery(
  assistantId: string | null,
  filter: ConversationListFilter | null,
  enabled: boolean,
): ConversationListQueryResult {
  const canQuery = useCanQueryDaemon(assistantId);
  /* An array, not a tuple, so `useQueries` types the results as a list of
     one query kind whether it holds zero entries or one. */
  const queries: ListQueryOptions[] =
    filter === null
      ? []
      : [
          {
            ...conversationListOptions(assistantId ?? "", filter),
            enabled: enabled && Boolean(assistantId) && canQuery,
          },
        ];
  const query: UseQueryResult<ConversationListPage> | undefined = useQueries({
    queries,
  })[0];
  if (query === undefined) {
    return NO_QUERY;
  }
  return {
    conversations: query.data?.conversations ?? EMPTY_CONVERSATIONS,
    isLoading: query.isLoading,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    hasData: query.data !== undefined,
    hasMore: query.data?.hasMore ?? false,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * The foreground conversation list: the primary list that gates the initial
 * chat render. Background and scheduled jobs are excluded on purpose; they
 * load through their own hooks only when the user reveals them, so the
 * initial render is never blocked on a large background backlog.
 */
export function useConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): ConversationListQueryResult {
  return useListQuery(assistantId, FOREGROUND_FILTER, enabled);
}

/** The background conversation list, its own cache from the foreground list. */
export function useBackgroundConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): ConversationListQueryResult {
  return useListQuery(assistantId, BACKGROUND_FILTER, enabled);
}

/**
 * The scheduled conversation list, its own cache so revealing the Scheduled
 * section fetches only scheduled jobs, independently of the background
 * backlog.
 */
export function useScheduledConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): ConversationListQueryResult {
  return useListQuery(assistantId, SCHEDULED_FILTER, enabled);
}

/**
 * One sidebar section's conversations (a group and/or channel filter), or
 * nothing for a section that has no server filter (`null`: a channel this
 * client's schema does not carry, or Chats below the native-origin gate).
 *
 * Each section mounts its own instance, so its contents come from the server
 * rather than from filtering another section's list. That is what lets a
 * pinned conversation appear in Pinned even when it sorts many pages deep in
 * the full list.
 */
export function useSectionConversationListQuery(
  assistantId: string | null,
  filter: ConversationListFilter | null,
  enabled: boolean = true,
): ConversationListQueryResult {
  return useListQuery(assistantId, filter, enabled);
}

/**
 * The archived conversations of every type, newest-archived first.
 *
 * Two caches, merged here: the daemon's `conversationType` defaults to
 * standard and has no "all", so archived background rows are a second read
 * ({@link ARCHIVED_BACKGROUND_FILTER}). Either failing is the whole list
 * failing: this is presented as the complete set, and an archived row that
 * looks gone is worse than an error with a retry.
 */
export function useArchivedConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): ConversationListQueryResult {
  const foreground = useListQuery(assistantId, ARCHIVED_FILTER, enabled);
  const background = useListQuery(
    assistantId,
    ARCHIVED_BACKGROUND_FILTER,
    enabled,
  );
  const conversations = useMemo(() => {
    const merged = mergeConversationLists(
      foreground.conversations,
      background.conversations,
    );
    return merged === foreground.conversations
      ? merged
      : [...merged].sort(byTimestampDesc("archivedAt"));
  }, [foreground.conversations, background.conversations]);
  return {
    conversations,
    isLoading: foreground.isLoading || background.isLoading,
    isPending: foreground.isPending || background.isPending,
    isError: foreground.isError || background.isError,
    error: foreground.error ?? background.error,
    hasData: foreground.hasData && background.hasData,
    hasMore: false,
    refetch: () => {
      foreground.refetch();
      background.refetch();
    },
  };
}

/**
 * Subscribe to the sidebar section index
 * (`GET /v1/conversations/sections`).
 *
 * Returns the daemon's per-section rows, or `null` while unresolved and when
 * the connected assistant does not serve the endpoint (pre-index daemons 404
 * the read, which the fetcher maps to `null`). `null` is the signal to keep
 * deriving section existence from the loaded conversation list; the two
 * sources must never be mixed within one render.
 *
 * Freshness comes from the same channels as the unread count:
 * `sync_changed`-driven invalidation and mutation settles, never focus
 * refetches.
 */
export function useSidebarSectionsQuery(
  assistantId: string | null,
  enabled: boolean = true,
): SidebarIndexSection[] | null {
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...sidebarSectionsOptions(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
  });
  return query.data ?? null;
}

/**
 * Subscribe to the raw server-side unread conversation count
 * (`GET /v1/conversations/unread-count`).
 *
 * Returns the count, or `null` while unresolved and when the connected
 * assistant does not serve the endpoint (pre-unread-count daemons 404 the
 * read, which the fetcher maps to `null`).
 *
 * Most callers want {@link useUnreadConversationCount}, which resolves that
 * `null` into a usable number. Use this one only when "the server does not
 * provide a count" has to be distinguishable from "the count is zero".
 *
 * Freshness comes from three channels rather than focus refetches:
 * optimistic deltas applied by the seen/unseen mutations
 * (`adjustUnreadCountCache`), the settle-time invalidation in
 * `invalidateConversationQueries`, and the `sync_changed`-driven
 * invalidation in `use-conversation-sync.ts`.
 */
export function useUnreadConversationCountQuery(
  assistantId: string | null,
  enabled: boolean = true,
): number | null {
  const canQuery = useCanQueryDaemon(assistantId);
  const query = useQuery({
    ...unreadConversationCountOptions(assistantId!),
    enabled: enabled && Boolean(assistantId) && canQuery,
  });
  return query.data ?? null;
}

/**
 * The unread conversation count to display: the server's count when it is
 * available, otherwise derived from `fallbackConversations`.
 *
 * Every unread-count surface should read this rather than compose the
 * fallback itself, so the "which source won" rule lives in one place.
 *
 * The fallback covers assistants without the endpoint and the window before
 * the query resolves. It counts only the conversations it is handed, so it is
 * accurate only while the caller holds the complete list; see
 * {@link countUnreadConversationsInList}.
 *
 * Clamping at zero happens here rather than in `adjustUnreadCountCache`,
 * which keeps optimistic adjustments exactly reversible: the cached value can
 * dip below zero when optimistic writes outrun the server, and this is the
 * boundary where that becomes a number a user sees.
 */
export function useUnreadConversationCount(
  assistantId: string | null,
  fallbackConversations: readonly Conversation[],
  enabled: boolean = true,
): number {
  const serverCount = useUnreadConversationCountQuery(assistantId, enabled);
  const derivedCount = useMemo(
    () => countUnreadConversationsInList(fallbackConversations),
    [fallbackConversations],
  );
  return Math.max(0, serverCount ?? derivedCount);
}

/**
 * Subscribe to the conversation groups (folders) for the given assistant.
 *
 * `conversationGroups` is an `[]` fallback in three different situations that
 * a consumer may need to tell apart from a genuinely group-less assistant:
 * the first fetch is in flight, the query is gated (on `enabled`, on the
 * assistant, or on the daemon) and so has not started, and the fetch failed
 * terminally. `isLoading` answers only the first: a gated query is pending
 * without ever loading, and an error is invisible to it. A consumer that
 * writes the groups somewhere durable (the iOS widget snapshot) must know the
 * query actually SUCCEEDED, which is `!isPending && !isError`; a consumer that
 * only draws a spinner keeps reading `isLoading`.
 */
export function useConversationGroupsQuery(
  assistantId: string | null,
  enabled: boolean = true,
): {
  conversationGroups: ConversationGroup[];
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
} {
  const canQuery = useCanQueryDaemon(assistantId);
  const query = useQuery({
    ...groupsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    } as Options<GroupsGetData>),
    select: (data) => data.groups,
    enabled: enabled && Boolean(assistantId) && canQuery,
    staleTime: 30_000,
  });
  return {
    conversationGroups: query.data ?? EMPTY_GROUPS,
    isLoading: query.isLoading,
    isPending: query.isPending,
    isError: query.isError,
  };
}
