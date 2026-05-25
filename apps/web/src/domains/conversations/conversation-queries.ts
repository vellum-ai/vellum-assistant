/**
 * TanStack Query hooks and cache helpers for the conversations domain.
 *
 * Conversations and conversation groups are server-derived data and live
 * in TanStack Query per `apps/web/docs/STATE_MANAGEMENT.md`. The
 * companion `conversation-store.ts` keeps only the client-side slice —
 * active/editing key, processing/attention sets, and snapshots.
 *
 * Two queries cover the surface:
 *
 * - **`useChatContextQuery` / `useConversationListQuery`** — wraps the
 *   `getChatContext` bootstrapping fetch. The returned `ChatContext`
 *   carries the conversation list (`conversations`) plus the initially
 *   resolved assistant + default conversation key. Sidebar and chat
 *   consumers read `conversations` via the convenience wrapper; the
 *   loader hook reads the full context for boot-time selection.
 *
 * - **`useConversationGroupsQuery`** — wraps `fetchGroups`. Mounted
 *   conditionally behind the `conversationGroupsUI` flag.
 *
 * Mutations (archive/unarchive, rename, pin, group CRUD, draft
 * resolution, SSE-driven title updates) update the cache via the named
 * helpers below. Each is a thin wrapper around `queryClient.setQueryData`
 * so call sites stay declarative.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/queries
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import { type QueryClient, useQuery } from "@tanstack/react-query";

import {
  type ChatContext,
  getChatContext,
} from "@/domains/chat/api/assistant.js";
import {
  type Conversation,
  type ConversationGroup,
  fetchGroups,
} from "@/domains/chat/api/conversations.js";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

import {
  CHAT_CONTEXT_QUERY_KEY,
  CONVERSATION_GROUPS_QUERY_KEY,
  chatContextQueryKey,
  conversationGroupsQueryKey,
} from "@/lib/sync/query-tags.js";

export {
  CHAT_CONTEXT_QUERY_KEY,
  CONVERSATION_GROUPS_QUERY_KEY,
  chatContextQueryKey,
  conversationGroupsQueryKey,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const QUERY_STALE_TIME_MS = 30_000;

/**
 * Subscribe to the bootstrapping chat context. Sidebar/list consumers
 * should prefer {@link useConversationListQuery}; only the loader needs
 * the full `{ assistantId, conversationId, conversations }` payload.
 */
export function useChatContextQuery(
  assistantId: string | null,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: chatContextQueryKey(assistantId),
    queryFn: getChatContext,
    enabled: enabled && Boolean(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Subscribe to the conversation list for the given assistant.
 *
 * Returns an empty array until the query resolves so consumers can render
 * an empty sidebar without null-checking. Cache writes from mutations and
 * SSE handlers feed through here automatically.
 *
 * `isError` and `refetch` are exposed so chat-surface consumers can
 * surface a visible error state when the conversation list fails — most
 * notably for self-hosted assistants, where a missing actor-token JWT
 * surfaces as a gateway 401 that has to terminate the loading spinner
 * with an actionable retry instead of silently keeping the sidebar
 * empty.
 */
export function useConversationListQuery(
  assistantId: string | null,
  enabled: boolean = true,
): {
  conversations: Conversation[];
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = useChatContextQuery(assistantId, enabled);
  return {
    conversations: query.data?.conversations ?? EMPTY_CONVERSATIONS,
    isLoading: query.isLoading,
    isPending: query.isPending,
    isError: query.isError,
    // Wrap in a void-returning closure so callers don't have to know
    // about TanStack's `QueryObserverResult` promise.
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
  const query = useQuery({
    queryKey: conversationGroupsQueryKey(assistantId),
    queryFn: () =>
      assistantId ? fetchGroups(assistantId) : Promise.resolve([]),
    enabled: enabled && Boolean(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
  return {
    conversationGroups: query.data ?? EMPTY_GROUPS,
    isLoading: query.isLoading,
  };
}

// Stable empty references so consumers don't churn on `??` fallback.
const EMPTY_CONVERSATIONS: Conversation[] = [];
const EMPTY_GROUPS: ConversationGroup[] = [];

// ---------------------------------------------------------------------------
// Cache helpers — conversations
//
// These mutate the chat-context query cache (where conversations live).
// They are the domain-level "change this conversation locally" operations;
// `queryClient.setQueryData` is implementation detail.
// ---------------------------------------------------------------------------

function updateChatContextConversations(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: (conversations: Conversation[]) => Conversation[],
): void {
  queryClient.setQueryData<ChatContext | null>(
    chatContextQueryKey(assistantId),
    (prev) => {
      if (!prev) return prev;
      const next = updater(prev.conversations);
      if (next === prev.conversations) return prev;
      return { ...prev, conversations: next };
    },
  );
}

/**
 * Read a single conversation from the chat-context query cache. Used by
 * imperative callers (send pipeline, attention tracking) that need the
 * current value without subscribing to re-renders.
 */
export function findConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
): Conversation | undefined {
  const ctx = queryClient.getQueryData<ChatContext | null>(
    chatContextQueryKey(assistantId),
  );
  return ctx?.conversations.find((c) => c.conversationId === key);
}

/**
 * Read all conversations from the chat-context query cache. Returns an
 * empty array when the query hasn't populated yet.
 */
export function getConversations(
  queryClient: QueryClient,
  assistantId: string | null,
): Conversation[] {
  return (
    queryClient.getQueryData<ChatContext | null>(
      chatContextQueryKey(assistantId),
    )?.conversations ?? []
  );
}

/**
 * Immutably patch the conversation matching `key`, leaving all others
 * untouched. No-op when the key is not in the cache.
 */
export function patchConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
  patch: Partial<Conversation>,
): void {
  updateChatContextConversations(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== key) return c;
      changed = true;
      return { ...c, ...patch };
    });
    return changed ? next : conversations;
  });
}

/**
 * Mark the conversation as seen in the local cache. The matching server
 * call (`markConversationSeen` in `chat/api/conversations.ts`) is fired
 * separately by callers — keep them independent so the cache update can
 * run regardless of network success.
 */
export function markConversationSeenLocal(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
  lastSeenAssistantMessageAt?: string,
): void {
  updateChatContextConversations(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== key) return c;
      changed = true;
      return {
        ...c,
        hasUnseenLatestAssistantMessage: false,
        lastSeenAssistantMessageAt:
          lastSeenAssistantMessageAt ??
          c.latestAssistantMessageAt ??
          c.lastSeenAssistantMessageAt,
      };
    });
    return changed ? next : conversations;
  });
}

export function prependConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): void {
  updateChatContextConversations(queryClient, assistantId, (conversations) => [
    conversation,
    ...conversations,
  ]);
}

export function removeConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
): void {
  updateChatContextConversations(queryClient, assistantId, (conversations) => {
    const filtered = conversations.filter((c) => c.conversationId !== key);
    return filtered.length === conversations.length ? conversations : filtered;
  });
}

export function resolveDraftKey(
  queryClient: QueryClient,
  assistantId: string | null,
  oldKey: string,
  newKey: string,
): void {
  updateChatContextConversations(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== oldKey) return c;
      changed = true;
      return { ...c, conversationId: newKey, draft: false };
    });
    return changed ? next : conversations;
  });
}

// ---------------------------------------------------------------------------
// Cache helpers — groups
// ---------------------------------------------------------------------------

function updateGroupsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: (groups: ConversationGroup[]) => ConversationGroup[],
): void {
  queryClient.setQueryData<ConversationGroup[]>(
    conversationGroupsQueryKey(assistantId),
    (prev) => {
      const list = prev ?? [];
      const next = updater(list);
      return next === list ? prev : next;
    },
  );
}

export function appendGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  group: ConversationGroup,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => [
    ...groups,
    {
      ...group,
      sortPosition: group.sortPosition || groups.length,
    },
  ]);
}

export function patchGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  groupId: string,
  patch: Partial<ConversationGroup>,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => {
    let changed = false;
    const next = groups.map((g) => {
      if (g.id !== groupId) return g;
      changed = true;
      return { ...g, ...patch };
    });
    return changed ? next : groups;
  });
}

export function replaceOptimisticGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  optimisticId: string,
  group: ConversationGroup,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => {
    let changed = false;
    const next = groups.map((g) => {
      if (g.id !== optimisticId) return g;
      changed = true;
      return group;
    });
    return changed ? next : groups;
  });
}

export function removeGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  groupId: string,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => {
    const filtered = groups.filter((g) => g.id !== groupId);
    return filtered.length === groups.length ? groups : filtered;
  });
}

/**
 * Atomically delete a group and clear its `groupId` from every affected
 * conversation in the chat-context cache.
 */
export function deleteGroupAndResetConversations(
  queryClient: QueryClient,
  assistantId: string | null,
  groupId: string,
): void {
  removeGroup(queryClient, assistantId, groupId);
  updateChatContextConversations(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.groupId !== groupId) return c;
      changed = true;
      return { ...c, groupId: undefined };
    });
    return changed ? next : conversations;
  });
}
