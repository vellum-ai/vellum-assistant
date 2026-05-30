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
 * - **`useConversationListQuery`** — fetches all conversations
 *   (foreground + background) for a given assistant via the generated
 *   `conversationsGet()` SDK with pagination and deduplication. The
 *   cache stores a flat `Conversation[]` under
 *   `conversationsQueryKey(assistantId)`. All sidebar, loader, and
 *   mutation cache-helper consumers read from this single entry.
 *
 * - **`useConversationGroupsQuery`** — wraps the generated
 *   `groupsGetOptions()`. Mounted conditionally behind the
 *   `conversationGroupsUI` flag.
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

import * as Sentry from "@sentry/browser";
import { type QueryClient, useQuery } from "@tanstack/react-query";

import {
  groupsGetOptions,
  groupsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  conversationsGet,
  type Options,
} from "@/generated/daemon/sdk.gen";
import type {
  GroupsGetData,
  GroupsGetResponse,
} from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import {
  ARCHIVED_CONVERSATIONS_QUERY_KEY,
  CONVERSATIONS_QUERY_KEY,
  archivedConversationsQueryKey,
  conversationsQueryKey,
} from "@/lib/sync/query-tags";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import {
  findConversation,
  getConversations,
  patchConversation,
  updateConversationsCache,
} from "@/utils/conversation-cache";

import {
  CONVERSATION_NOT_FOUND,
  fetchConversationDetail,
  type FetchConversationDetailResult,
} from "./fetch-conversation-detail";
import { toConversation } from "./conversation-transforms";

export { CONVERSATION_NOT_FOUND, type FetchConversationDetailResult };

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export {
  ARCHIVED_CONVERSATIONS_QUERY_KEY,
  CONVERSATIONS_QUERY_KEY,
  archivedConversationsQueryKey,
  conversationsQueryKey,
};

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
// Conversation list + detail fetching
// ---------------------------------------------------------------------------

const CONVERSATION_LIST_PAGE_SIZE = 50;
const CONVERSATION_LIST_MAX_PAGES = 200;

type FetchConversationListOptions = {
  conversationType?: "background";
  /**
   * Filter by archive state. Defaults to `"active"` on the daemon side, so
   * omitting this returns non-archived rows only — matching how the sidebar
   * wants to read the list. The Archive page passes `"archived"`.
   */
  archiveStatus?: "active" | "archived" | "all";
};

async function fetchConversationList(
  assistantId: string,
  options: FetchConversationListOptions = {},
): Promise<Conversation[]> {
  const { conversationType, archiveStatus } = options;
  const all: Conversation[] = [];

  for (let page = 0; page < CONVERSATION_LIST_MAX_PAGES; page++) {
    const offset = page * CONVERSATION_LIST_PAGE_SIZE;
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

    const conversations = data?.conversations ?? [];
    all.push(...conversations.map(toConversation));

    const hasMore = data?.hasMore ?? false;
    if (!hasMore) break;

    if (conversations.length === 0) break;
  }

  return all;
}

/**
 * Fetch all active (non-archived) conversations — foreground + background —
 * for a given assistant. Both buckets are fetched in parallel and merged so
 * the sidebar can display every conversation type. Returns sorted
 * newest-first.
 *
 * Archived conversations are filtered out on the daemon (the
 * `archiveStatus` query param defaults to `"active"`), so the sidebar no
 * longer paginates past stale archived rows. The Archive page reads from
 * `listArchivedConversations` instead.
 *
 * The background fetch is best-effort: if it fails the foreground list is
 * still returned so the sidebar remains usable.
 */
export async function listConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const [foregroundResult, backgroundResult] = await Promise.allSettled([
    fetchConversationList(assistantId),
    fetchConversationList(assistantId, { conversationType: "background" }),
  ]);

  if (foregroundResult.status === "rejected") {
    throw foregroundResult.reason;
  }

  const foreground = foregroundResult.value;
  let background: Conversation[] = [];
  if (backgroundResult.status === "fulfilled") {
    background = backgroundResult.value;
  } else {
    Sentry.captureException(backgroundResult.reason, {
      level: "warning",
      tags: { context: "listConversations.backgroundFetch" },
      extra: { assistantId },
    });
  }

  const seen = new Set<string>();
  const conversations: Conversation[] = [];
  for (const conversation of [...foreground, ...background]) {
    if (seen.has(conversation.conversationId)) {
      continue;
    }
    seen.add(conversation.conversationId);
    conversations.push(conversation);
  }

  conversations.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

  return conversations;
}

/**
 * Fetch all archived conversations — foreground + background — for a given
 * assistant. Mirrors `listConversations` but passes `archiveStatus:
 * "archived"` so the daemon returns only archived rows. Sorted by
 * `archivedAt` descending so the most recently archived row is first.
 *
 * The background fetch is best-effort: if it fails the foreground list is
 * still returned so the archive page remains usable.
 */
export async function listArchivedConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const [foregroundResult, backgroundResult] = await Promise.allSettled([
    fetchConversationList(assistantId, { archiveStatus: "archived" }),
    fetchConversationList(assistantId, {
      conversationType: "background",
      archiveStatus: "archived",
    }),
  ]);

  if (foregroundResult.status === "rejected") {
    throw foregroundResult.reason;
  }

  const foreground = foregroundResult.value;
  let background: Conversation[] = [];
  if (backgroundResult.status === "fulfilled") {
    background = backgroundResult.value;
  } else {
    Sentry.captureException(backgroundResult.reason, {
      level: "warning",
      tags: { context: "listArchivedConversations.backgroundFetch" },
      extra: { assistantId },
    });
  }

  const seen = new Set<string>();
  const conversations: Conversation[] = [];
  for (const conversation of [...foreground, ...background]) {
    if (seen.has(conversation.conversationId)) {
      continue;
    }
    seen.add(conversation.conversationId);
    conversations.push(conversation);
  }

  conversations.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));

  return conversations;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const QUERY_STALE_TIME_MS = 30_000;

/**
 * Subscribe to the conversation list for the given assistant.
 *
 * Fetches all conversations (foreground + background) via
 * `listConversations()`, which paginates both lists in parallel,
 * deduplicates, and sorts newest-first. The cache stores a flat
 * `Conversation[]`.
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
  const query = useQuery({
    queryKey: conversationsQueryKey(assistantId),
    queryFn: () => listConversations(assistantId!),
    enabled: enabled && Boolean(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
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
  const query = useQuery({
    queryKey: archivedConversationsQueryKey(assistantId),
    queryFn: () => listArchivedConversations(assistantId!),
    enabled: enabled && Boolean(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
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
// The low-level `Conversation[]` cache primitives (`updateConversationsCache`,
// `findConversation`, `getConversations`, `patchConversation`) live in
// `@/utils/conversation-cache` so the chat stream handlers can share them
// without a cross-domain import. They're re-exported here so existing
// conversations-domain consumers keep their import site. The domain-level
// mutations below build on `updateConversationsCache`.
// ---------------------------------------------------------------------------

export { findConversation, getConversations, patchConversation };

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
  lastSeenAssistantMessageAt?: number,
): void {
  updateConversationsCache(queryClient, assistantId, (conversations) => {
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
  updateConversationsCache(queryClient, assistantId, (conversations) => [
    conversation,
    ...conversations,
  ]);
}

export function removeConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
): void {
  updateConversationsCache(queryClient, assistantId, (conversations) => {
    const filtered = conversations.filter((c) => c.conversationId !== key);
    return filtered.length === conversations.length ? conversations : filtered;
  });
}

/**
 * Refresh a single conversation row in the cached sidebar list by
 * fetching `GET /v1/conversations/:id` and patching the cache in place.
 *
 * Drives the per-conversation `sync_changed` metadata-tag handler in
 * `use-conversation-sync.ts`: when the assistant emits a
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
  updateConversationsCache(queryClient, assistantId, (conversations) => {
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
  updateConversationsCache(queryClient, assistantId, (conversations) => {
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
 * conversation in the conversations cache.
 */
export function deleteGroupAndResetConversations(
  queryClient: QueryClient,
  assistantId: string | null,
  groupId: string,
): void {
  removeGroup(queryClient, assistantId, groupId);
  updateConversationsCache(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.groupId !== groupId) return c;
      changed = true;
      return { ...c, groupId: undefined };
    });
    return changed ? next : conversations;
  });
}
