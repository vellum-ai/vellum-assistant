/**
 * TanStack Query hooks for conversations and conversation groups.
 *
 * Conversations and conversation groups are server-derived data and live
 * in TanStack Query per `clients/web/docs/STATE_MANAGEMENT.md`. The
 * companion `conversation-store.ts` keeps only the client-side slice —
 * active/editing key, processing/attention sets, and snapshots.
 *
 * Each hook spreads a `queryOptions` factory from
 * `utils/conversation-list-fetchers.ts` and adds runtime concerns
 * (`enabled` gating via `useIsOrgReady()`, `select` transforms). This
 * co-locates `queryKey` + `queryFn` + `staleTime` in one place so they
 * can be reused across hooks, prefetches, and imperative cache reads.
 *
 * Cache mutation helpers live in `utils/conversation-cache-mutations.ts`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
 * - https://tanstack.com/query/latest/docs/framework/react/guides/queries
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { groupsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type { GroupsGetData } from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { countUnreadConversationsInList } from "@/utils/conversation-predicates";
import {
  archivedConversationListOptions,
  backgroundConversationListOptions,
  conversationListOptions,
  sectionConversationListOptions,
  scheduledConversationListOptions,
  sidebarSectionsOptions,
  unreadConversationCountOptions,
} from "@/utils/conversation-list-fetchers";
import type {
  SectionConversationFilter,
  SidebarIndexSection,
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
 * Fetches foreground conversations via `listConversations()` and stores a
 * flat `Conversation[]` under `conversationsQueryKey`. Background and
 * scheduled jobs are deliberately excluded — they load through
 * `useBackgroundConversationListQuery` only when the user reveals them — so
 * the initial chat render is never blocked on a large background backlog.
 *
 * Returns an empty array until the query resolves so consumers can render
 * an empty sidebar without null-checking. Cache writes from mutations and
 * SSE handlers feed through here automatically.
 *
 * `isError`, `error`, and `refetch` are exposed so chat-surface consumers
 * can surface a visible error state when the conversation list fails —
 * most notably for self-hosted assistants, where a missing actor-token
 * JWT surfaces as a gateway 401 that has to terminate the loading spinner
 * with an actionable retry instead of silently keeping the sidebar empty.
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
} {
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...conversationListOptions(assistantId!),
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
  isError: boolean;
  refetch: () => void;
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
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Subscribe to the scheduled conversation list for the given assistant.
 * Cached separately under `scheduledConversationsQueryKey` so revealing the
 * Scheduled section fetches only scheduled jobs, independently of the
 * background backlog.
 *
 * `enabled` gates the network fetch on whether the user has revealed the
 * Scheduled sidebar section. Passing `enabled: false` keeps the observer
 * subscribed to cache updates without firing a request — mirroring the
 * background hook so attention tracking reflects scheduled rows once loaded
 * without triggering the fetch itself.
 */
export function useScheduledConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): {
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
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
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * Subscribe to one sidebar section's conversations.
 *
 * Each section mounts its own instance, so its contents come from the server
 * rather than from filtering another section's list. That is what lets a
 * pinned conversation appear in Pinned even when it sorts many pages deep in
 * the full list.
 *
 * `enabled` gates the network fetch; passing `false` keeps the observer
 * subscribed to cache updates without firing a request.
 *
 * `hasData` rather than `isError` is what a section should branch on when
 * deciding whether to trust this result. The two are not complements: React
 * Query keeps the last successful data when a later refetch fails, so an
 * errored query can still be holding the section's real rows, and treating
 * `isError` as "unusable" would swap them for a worse list. `hasData` is
 * false in exactly the cases with nothing to show - never fetched, still
 * pending, or failed before it ever succeeded.
 */
export function useSectionConversationListQuery(
  assistantId: string | null,
  filter: SectionConversationFilter,
  enabled: boolean = true,
): {
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  /** Whether the query has ever resolved; survives a failed refetch. */
  hasData: boolean;
} {
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...sectionConversationListOptions(assistantId!, filter),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
  });
  return {
    conversations: query.data ?? EMPTY_CONVERSATIONS,
    isLoading: query.isLoading,
    isPending: query.isPending,
    isError: query.isError,
    hasData: query.data !== undefined,
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
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...unreadConversationCountOptions(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
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
 * Subscribe to the archived conversation list for the given assistant. The
 * cache lives under a separate query key (`archivedConversationsQueryKey`)
 * so that mutations to the active list don't refetch the archive view and
 * vice versa.
 *
 * Returns an empty array until the query resolves so consumers can render
 * an empty state without null-checking.
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
