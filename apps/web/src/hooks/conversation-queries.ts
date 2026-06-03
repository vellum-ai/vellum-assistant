/**
 * TanStack Query hooks for conversations and conversation groups.
 *
 * Conversations and conversation groups are server-derived data and live
 * in TanStack Query per `apps/web/docs/STATE_MANAGEMENT.md`. The
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

import { useQuery } from "@tanstack/react-query";

import {
  groupsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  GroupsGetData,
} from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import {
  archivedConversationListOptions,
  backgroundConversationListOptions,
  conversationListOptions,
  scheduledConversationListOptions,
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
