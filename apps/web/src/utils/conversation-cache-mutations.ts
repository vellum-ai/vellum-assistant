/**
 * Domain-level cache mutation helpers for conversations.
 *
 * Each function is a thin `queryClient.setQueryData` wrapper so call sites
 * stay declarative. Low-level cache primitives (`updateConversationsCache`,
 * `findConversation`, `patchConversation`) live in `@/utils/conversation-cache`.
 * Group cache mutations live in `@/utils/conversation-group-cache-mutations`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { Conversation } from "@/types/conversation-types";
import {
  isBackgroundConversation,
  isScheduledConversation,
} from "@/utils/conversation-predicates";
import {
  findConversation,
  prependToConversationsCache,
  updateAllConversationCaches,
  updateBackgroundConversationsCache,
  updateConversationsCache,
  updateScheduledConversationsCache,
} from "@/utils/conversation-cache";
import {
  backgroundConversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import {
  type ConversationListPage,
  conversationListInfiniteQueryKey,
  listBackgroundConversationsFirstPage,
  listScheduledConversationsFirstPage,
  unreadCountQueryKey,
} from "@/utils/conversation-list-fetchers";
import {
  ConversationNotFoundError,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";

// ---------------------------------------------------------------------------
// Conversation cache helpers
// ---------------------------------------------------------------------------

/**
 * Mark the conversation as seen in the local cache and invalidate the
 * server-side unread count so the dock badge updates immediately rather
 * than waiting for the next 30-second poll.
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
  void queryClient.invalidateQueries({
    queryKey: unreadCountQueryKey(assistantId),
  });
}

export function prependConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): void {
  prependToConversationsCache(queryClient, assistantId, conversation);
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

export function shouldSurfaceConversationOnUserSend(
  conversation: Conversation,
): boolean {
  if (conversation.archivedAt != null) return false;
  if (conversation.surfacedAt != null) return false;
  if (conversation.isPinned === true || conversation.groupId === "system:pinned") {
    return false;
  }
  if (conversation.groupId && !conversation.groupId.startsWith("system:")) {
    return false;
  }
  return (
    isScheduledConversation(conversation) ||
    isBackgroundConversation(conversation)
  );
}

export function surfaceConversationInCaches(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
  surfacedAt: number,
  lastMessageAt = Date.now(),
): void {
  const surfacedConversation: Conversation = {
    ...conversation,
    groupId: "system:all",
    surfacedAt,
    lastMessageAt: Math.max(conversation.lastMessageAt ?? 0, lastMessageAt),
  };

  // Update the conversation in background/scheduled caches in place.
  const replaceInPlace = (conversations: Conversation[]) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== conversation.conversationId) return c;
      changed = true;
      return surfacedConversation;
    });
    return changed ? next : conversations;
  };
  updateBackgroundConversationsCache(queryClient, assistantId, replaceInPlace);
  updateScheduledConversationsCache(queryClient, assistantId, replaceInPlace);

  // Atomically remove from current position and prepend to the top in a
  // single setQueryData pass — avoids a render frame where the conversation
  // vanishes from the cache between remove and prepend.
  const queryKey = conversationListInfiniteQueryKey(assistantId);
  queryClient.setQueryData<InfiniteData<ConversationListPage>>(queryKey, (old) => {
    if (!old || old.pages.length === 0) {
      return {
        pages: [{ conversations: [surfacedConversation], hasMore: false, nextOffset: 1 }],
        pageParams: [0],
      };
    }
    const [firstPage, ...rest] = old.pages;
    const filteredFirst = firstPage!.conversations.filter(
      (c) => c.conversationId !== conversation.conversationId,
    );
    const filteredRest = rest.map((page) => {
      const filtered = page.conversations.filter(
        (c) => c.conversationId !== conversation.conversationId,
      );
      return filtered === page.conversations ? page : { ...page, conversations: filtered };
    });
    return {
      ...old,
      pages: [
        { ...firstPage!, conversations: [surfacedConversation, ...filteredFirst] },
        ...filteredRest,
      ],
    };
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
 * - Server returns 404 ({@link ConversationNotFoundError}): remove the
 *   row from the cache. Mirrors how `deleteConversation` cleans up
 *   after a local deletion.
 * - Network / other errors: rethrown to the caller so the SSE consumer
 *   can log/sentry-capture without silently dropping the signal.
 */
export async function refreshConversationRow(
  queryClient: QueryClient,
  assistantId: string | null,
  conversationId: string,
): Promise<void> {
  if (!assistantId) return;

  let result: Conversation;
  try {
    result = await fetchConversationDetail(queryClient, assistantId, conversationId);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      removeConversation(queryClient, assistantId, conversationId);
      return;
    }
    throw err;
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
  prependToConversationsCache(queryClient, assistantId, result);
}

/**
 * Reconcile one fetched first page into a cached newest-first list.
 *
 * - `hasMore === false`: the page is the complete list — replace the cache.
 * - Otherwise the fresh rows win, and cached rows absent from the page
 *   survive only when they sort strictly below the page's window (older
 *   than the oldest non-pinned fresh row). A cached row whose timestamp
 *   falls inside the window but is missing from the page no longer lives
 *   there (deleted or archived), so it is dropped. Pinned rows are
 *   excluded from the cutoff because the daemon appends every pinned
 *   conversation to page 1 regardless of age — an ancient pinned row
 *   would otherwise collapse the cutoff and drop live rows.
 * - Client-local draft rows always survive; the server doesn't know them.
 *
 * The fresh window leads the result; surviving rows keep their existing
 * relative order.
 *
 * @internal Exported for testing.
 */
export function mergeListFirstPage(
  prev: Conversation[],
  page: ConversationListPage,
): Conversation[] {
  if (!page.hasMore) return page.conversations;
  const nonPinned = page.conversations.filter((c) => c.isPinned !== true);
  if (nonPinned.length === 0) return prev;
  const cutoff = Math.min(...nonPinned.map((c) => c.lastMessageAt ?? 0));
  const freshIds = new Set(page.conversations.map((c) => c.conversationId));
  const kept = prev.filter(
    (c) =>
      !freshIds.has(c.conversationId) &&
      (c.draft === true || (c.lastMessageAt ?? 0) < cutoff),
  );
  return [...page.conversations, ...kept];
}

const FLAT_LIST_BUCKETS = [
  {
    queryKey: backgroundConversationsQueryKey,
    fetchFirstPage: listBackgroundConversationsFirstPage,
  },
  {
    queryKey: scheduledConversationsQueryKey,
    fetchFirstPage: listScheduledConversationsFirstPage,
  },
] as const;

/**
 * Refresh conversation list caches after a sync signal.
 *
 * - Foreground: invalidates the infinite query (cheap — only loaded pages
 *   are refetched, typically 1–2 pages of 50 items each).
 * - Background/Scheduled: fetches just the first page per bucket and merges
 *   via {@link mergeListFirstPage}, avoiding a full paginated drain.
 * - Unread count: invalidated so the badge stays current.
 *
 * Buckets that were never fetched (collapsed sidebar sections) are
 * skipped — their queries fetch on first expand anyway.
 */
export async function refreshConversationListWindows(
  queryClient: QueryClient,
  assistantId: string | null,
): Promise<void> {
  if (!assistantId) return;

  // Foreground uses useInfiniteQuery — invalidation refetches only loaded pages.
  void queryClient.invalidateQueries({
    queryKey: conversationListInfiniteQueryKey(assistantId),
  });
  void queryClient.invalidateQueries({
    queryKey: unreadCountQueryKey(assistantId),
  });

  // Background/scheduled use flat Conversation[] caches — merge first page.
  await Promise.all(
    FLAT_LIST_BUCKETS.map(async (bucket) => {
      const queryKey = bucket.queryKey(assistantId);
      if (queryClient.getQueryData<Conversation[]>(queryKey) === undefined) {
        return;
      }
      const page = await bucket.fetchFirstPage(assistantId);
      queryClient.setQueryData<Conversation[]>(
        queryKey,
        (prev: Conversation[] | undefined) =>
          prev === undefined ? undefined : mergeListFirstPage(prev, page),
      );
    }),
  );
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


