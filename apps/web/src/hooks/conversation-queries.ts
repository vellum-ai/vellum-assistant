/**
 * TanStack Query hooks and cache helpers for conversations.
 *
 * Conversations and conversation groups are server-derived data and live
 * in TanStack Query per `apps/web/docs/STATE_MANAGEMENT.md`. The
 * companion `conversation-store.ts` keeps only the client-side slice —
 * active/editing key, processing/attention sets, and snapshots.
 *
 * Queries covering the surface:
 *
 * - **`useConversationListQuery`** — fetches the foreground conversations
 *   for a given assistant via the generated `conversationsGet()` SDK with
 *   pagination and deduplication. The cache stores a flat `Conversation[]`
 *   under `conversationsQueryKey(assistantId)`.
 *
 * - **`useBackgroundConversationListQuery`** — fetches background jobs into
 *   a separate cache under `backgroundConversationsQueryKey(assistantId)`.
 *   Enabled lazily so the backlog never blocks the initial chat render.
 *
 * - **`useScheduledConversationListQuery`** — fetches scheduled jobs into
 *   their own cache under `scheduledConversationsQueryKey(assistantId)`,
 *   enabled lazily and independently of the background list so revealing
 *   the Scheduled section never pulls in the heavier background backlog.
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
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  archivedConversationsQueryKey,
  backgroundConversationsQueryKey,
  conversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import {
  isBackgroundConversation,
  isScheduledConversation,
} from "@/utils/conversation-predicates";
import {
  findConversation,
  updateAllConversationCaches,
  updateBackgroundConversationsCache,
  updateConversationsCache,
  updateScheduledConversationsCache,
} from "@/utils/conversation-cache";

import {
  CONVERSATION_NOT_FOUND,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";
import { toConversation } from "@/utils/conversation-transforms";

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
  conversationType?: "background" | "scheduled";
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
 * Fetch active or archived conversations for an assistant — foreground and
 * background buckets fetched in parallel, deduplicated by `conversationId`,
 * and sorted. Used by the Archive page, which lists every conversation type
 * together.
 *
 * The background fetch is best-effort: if it fails the foreground list is
 * still returned so the calling surface remains usable.
 *
 * @param archiveStatus — `"active"` or `"archived"` (archive page)
 * @param sortKey — which timestamp to sort descending by (default: `lastMessageAt`)
 */
async function fetchMergedConversationList(
  assistantId: string,
  archiveStatus: "active" | "archived" = "active",
  sortKey: "lastMessageAt" | "archivedAt" = "lastMessageAt",
): Promise<Conversation[]> {
  const opts: FetchConversationListOptions = archiveStatus === "active" ? {} : { archiveStatus };
  const bgOpts: FetchConversationListOptions = { ...opts, conversationType: "background" };

  const [foregroundResult, backgroundResult] = await Promise.allSettled([
    fetchConversationList(assistantId, opts),
    fetchConversationList(assistantId, bgOpts),
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
      tags: { context: `fetchMergedConversationList.background(${archiveStatus})` },
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

  conversations.sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0));
  return conversations;
}

/**
 * Fetch all active (non-archived) foreground conversations for a given
 * assistant, sorted newest-first.
 *
 * Background and scheduled jobs are intentionally excluded — they load
 * through `listBackgroundConversations` / `listScheduledConversations` only
 * once the user expands the Background/Scheduled sidebar sections, so a large
 * background backlog never blocks the initial chat render (the conversation
 * the user actually opened).
 */
export async function listConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const foreground = await fetchConversationList(assistantId);
  return [...foreground].sort(
    (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
  );
}

/**
 * Fetch all active (non-archived) background conversations for a given
 * assistant, sorted newest-first.
 *
 * The daemon's `conversationType=background` filter is the back-compat
 * umbrella that also returns scheduled rows, so those are filtered out here
 * to keep the background cache disjoint from the scheduled cache (one
 * conversation, one cache). Scheduled jobs load through
 * `listScheduledConversations` instead.
 *
 * Mounted lazily by the sidebar — only enabled once the user reveals the
 * Background section — so this never runs on the initial load path. Cached
 * separately from the foreground list under `backgroundConversationsQueryKey`.
 */
export async function listBackgroundConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const background = await fetchConversationList(assistantId, {
    conversationType: "background",
  });
  return background
    .filter((c) => !isScheduledConversation(c))
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
}

/**
 * Fetch all active (non-archived) scheduled conversations for a given
 * assistant, sorted newest-first.
 *
 * Uses the daemon's dedicated `conversationType=scheduled` filter so the
 * Scheduled sidebar section can load independently of the background
 * backlog. Mounted lazily — only enabled once the user reveals the
 * Scheduled section — so this never runs on the initial load path. Cached
 * separately under `scheduledConversationsQueryKey`.
 */
export async function listScheduledConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const scheduled = await fetchConversationList(assistantId, {
    conversationType: "scheduled",
  });
  return [...scheduled].sort(
    (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
  );
}

/**
 * Fetch all archived conversations for the archive page.
 * Sorted by `archivedAt` descending (most recently archived first).
 */
export async function listArchivedConversations(
  assistantId: string,
): Promise<Conversation[]> {
  return fetchMergedConversationList(assistantId, "archived", "archivedAt");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const QUERY_STALE_TIME_MS = 30_000;

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
    queryKey: conversationsQueryKey(assistantId),
    queryFn: () => listConversations(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
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
    queryKey: backgroundConversationsQueryKey(assistantId),
    queryFn: () => listBackgroundConversations(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
    staleTime: QUERY_STALE_TIME_MS,
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
    queryKey: scheduledConversationsQueryKey(assistantId),
    queryFn: () => listScheduledConversations(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
    staleTime: QUERY_STALE_TIME_MS,
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
    queryKey: archivedConversationsQueryKey(assistantId),
    queryFn: () => listArchivedConversations(assistantId!),
    enabled: enabled && Boolean(assistantId) && isOrgReady,
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
  const isOrgReady = useIsOrgReady();
  const query = useQuery({
    ...groupsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    } as Options<GroupsGetData>),
    select: (data) => data.groups,
    enabled: enabled && Boolean(assistantId) && isOrgReady,
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
// Low-level cache primitives (`updateConversationsCache`, `findConversation`,
// `getConversations`, `patchConversation`) live in `@/utils/conversation-cache`.
// Import them from source. The domain-level mutations below build on
// `updateConversationsCache`.
// ---------------------------------------------------------------------------

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
  const markSeen = (conversations: Conversation[]) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== key) {
        return c;
      }
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
  };
  updateAllConversationCaches(queryClient, assistantId, markSeen);
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
  const drop = (conversations: Conversation[]) => {
    const filtered = conversations.filter((c) => c.conversationId !== key);
    return filtered.length === conversations.length ? conversations : filtered;
  };
  updateAllConversationCaches(queryClient, assistantId, drop);
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

  // Replace the row in whichever cache already holds it. Only when it lives
  // in neither do we append, routing the new row to the cache that matches
  // its type so a background job never lands in the foreground list.
  const replaceMatching = (conversations: Conversation[]) => {
    let replaced = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== result.conversationId) {
        return c;
      }
      replaced = true;
      return result;
    });
    return replaced ? next : conversations;
  };

  const existing = findConversation(queryClient, assistantId, conversationId);
  if (existing) {
    updateAllConversationCaches(queryClient, assistantId, replaceMatching);
    return;
  }

  if (isScheduledConversation(result)) {
    updateScheduledConversationsCache(queryClient, assistantId, (conversations) => [
      ...conversations,
      result,
    ]);
    return;
  }
  if (isBackgroundConversation(result)) {
    updateBackgroundConversationsCache(queryClient, assistantId, (conversations) => [
      ...conversations,
      result,
    ]);
    return;
  }
  updateConversationsCache(queryClient, assistantId, (conversations) => [
    ...conversations,
    result,
  ]);
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
  const clearGroupId = (conversations: Conversation[]) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.groupId !== groupId) {
        return c;
      }
      changed = true;
      return { ...c, groupId: undefined };
    });
    return changed ? next : conversations;
  };
  updateAllConversationCaches(queryClient, assistantId, clearGroupId);
}
