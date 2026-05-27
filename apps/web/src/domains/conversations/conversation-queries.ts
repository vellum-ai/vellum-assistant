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
} from "@/domains/chat/api/assistant";
import {
  groupsGetOptions,
  groupsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  GroupsGetData,
  GroupsGetResponse,
} from "@/generated/daemon/types.gen";
import {
  CONVERSATION_NOT_FOUND,
  type Conversation,
  type ConversationGroup,
  fetchConversationDetail,
} from "@/lib/conversations-api";
import {
  CHAT_CONTEXT_QUERY_KEY,
  chatContextQueryKey,
} from "@/lib/sync/query-tags";

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export { CHAT_CONTEXT_QUERY_KEY, chatContextQueryKey };

/**
 * Build the generated query key for conversation groups. Exported so that
 * invalidation call sites (sync stream, loader, group actions) can target
 * the same cache entry that `useConversationGroupsQuery` populates.
 */
export function conversationGroupsQueryKey(
  assistantId: string | null,
): ReturnType<typeof groupsGetQueryKey> {
  return groupsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  } as Options<GroupsGetData>);
}

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
    ...groupsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    } as Options<GroupsGetData>),
    select: (data) => data.groups,
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

/**
 * Refresh a single conversation row in the cached sidebar list by
 * fetching `GET /v1/conversations/:id` and patching the cache in place.
 *
 * Drives the per-conversation `sync_changed` metadata-tag handler in
 * `use-assistant-sync-stream.ts`: when the assistant emits a
 * `conversation:<id>:metadata` invalidation for a content-only change
 * (seen state, title, attention cursor), the consumer GETs that single
 * row instead of refetching the full paginated list — a single request
 * per signal instead of the legacy ~14-request drain at a few hundred
 * conversations.
 *
 * Behavior:
 * - Row present and server returns a payload: replace the cached row
 *   with the server copy (shape is identical — both ends serialize via
 *   `serializeConversationSummary`).
 * - Row absent from cache but server returns a payload: append; the
 *   row will sort into place on the next list refetch.
 * - Server returns 404 (`CONVERSATION_NOT_FOUND`): remove the row from
 *   the cache. Mirrors how `deleteConversation` cleans up after a local
 *   deletion.
 * - Network / other errors: rethrown to the caller so the SSE consumer
 *   can log/sentry-capture without silently dropping the signal.
 */
export async function refreshConversationRow(
  queryClient: QueryClient,
  assistantId: string | null,
  conversationId: string,
): Promise<void> {
  if (!assistantId) return;
  const result = await fetchConversationDetail(assistantId, conversationId);
  if (result === CONVERSATION_NOT_FOUND) {
    removeConversation(queryClient, assistantId, conversationId);
    return;
  }
  updateChatContextConversations(queryClient, assistantId, (conversations) => {
    let replaced = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== result.conversationId) return c;
      replaced = true;
      return result;
    });
    if (replaced) return next;
    return [...conversations, result];
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
  queryClient.setQueryData<GroupsGetResponse>(
    conversationGroupsQueryKey(assistantId),
    (prev) => {
      const list = prev?.groups ?? [];
      const next = updater(list);
      if (next === list) return prev;
      return { ...prev, groups: next };
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
