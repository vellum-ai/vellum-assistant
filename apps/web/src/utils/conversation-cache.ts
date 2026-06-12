/**
 * Low-level read/write helpers over the conversation query caches.
 *
 * Conversations are split across multiple caches:
 *
 * - **Foreground** (infinite query) — the primary list that gates the initial
 *   chat render. Stored as `InfiniteData<ConversationPage>` under the
 *   generated infinite query key. Loads one page on mount; additional pages
 *   load on demand.
 * - **Background** under `backgroundConversationsQueryKey` — background jobs
 *   only. Fetched lazily, only once the user reveals the Background sidebar
 *   section, so a large backlog never blocks the first paint.
 * - **Scheduled** under `scheduledConversationsQueryKey` — scheduled jobs
 *   only. Fetched lazily and independently, only once the user reveals the
 *   Scheduled sidebar section.
 * - **Archived** under `archivedConversationsQueryKey` — archived
 *   conversations. Fetched lazily when the user opens the archive view.
 *
 * A conversation lives in exactly one cache, so the cross-cache helpers
 * (`findConversation`, `getConversations`, `patchConversation`) read from
 * all four and write to all four — the caches that don't hold the row are
 * a no-op.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
 * - https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
 */

import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import {
  archivedConversationsQueryKey,
  backgroundConversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import {
  conversationListInfiniteQueryKey,
  flattenConversationPages,
  type ConversationPage,
} from "@/utils/conversation-list-fetchers";
import type { Conversation } from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ConversationUpdater = (conversations: Conversation[]) => Conversation[];

/** Background, scheduled, and archived query keys (flat Conversation[]). */
function flatConversationQueryKeys(assistantId: string | null) {
  return [
    backgroundConversationsQueryKey(assistantId),
    scheduledConversationsQueryKey(assistantId),
    archivedConversationsQueryKey(assistantId),
  ] as const;
}

// ---------------------------------------------------------------------------
// Query lifecycle helpers — cancel, snapshot, restore, invalidate
// ---------------------------------------------------------------------------

/**
 * Cancel any in-flight refetches for conversation caches. Call this before
 * applying an optimistic update so a concurrent refetch doesn't overwrite
 * the optimistic value with stale server data.
 */
export async function cancelConversationQueries(
  queryClient: QueryClient,
  assistantId: string,
): Promise<void> {
  const promises = [
    queryClient.cancelQueries({
      queryKey: conversationListInfiniteQueryKey(assistantId),
    }),
    ...flatConversationQueryKeys(assistantId).map((key) =>
      queryClient.cancelQueries({ queryKey: key }),
    ),
  ];
  await Promise.all(promises);
}

/**
 * Snapshot of all conversation caches for a given assistant, used for
 * rollback in `onError` after a failed optimistic mutation.
 */
export interface ConversationCacheSnapshot {
  infiniteQueryKey: readonly unknown[];
  infiniteData: InfiniteData<ConversationPage> | undefined;
  flatCaches: Array<[queryKey: readonly unknown[], data: Conversation[] | undefined]>;
}

/**
 * Capture the current state of all conversation caches. The returned
 * snapshot can be passed to `restoreConversationCaches` to undo an
 * optimistic update.
 */
export function snapshotConversationCaches(
  queryClient: QueryClient,
  assistantId: string,
): ConversationCacheSnapshot {
  const infiniteQueryKey = conversationListInfiniteQueryKey(assistantId);
  return {
    infiniteQueryKey,
    infiniteData: queryClient.getQueryData<InfiniteData<ConversationPage>>(infiniteQueryKey),
    flatCaches: flatConversationQueryKeys(assistantId).map((key) => [
      key,
      queryClient.getQueryData<Conversation[]>(key),
    ]),
  };
}

/**
 * Restore conversation caches from a snapshot, undoing an optimistic update.
 */
export function restoreConversationCaches(
  queryClient: QueryClient,
  snapshot: ConversationCacheSnapshot,
): void {
  queryClient.setQueryData(snapshot.infiniteQueryKey, snapshot.infiniteData);
  for (const [key, data] of snapshot.flatCaches) {
    queryClient.setQueryData(key, data);
  }
}

/**
 * Invalidate all conversation caches so TanStack Query refetches from the
 * server. Used in `onSettled` to reconcile optimistic values with the
 * server-authoritative state regardless of mutation success or failure.
 */
export async function invalidateConversationQueries(
  queryClient: QueryClient,
  assistantId: string,
): Promise<void> {
  const promises = [
    queryClient.invalidateQueries({
      queryKey: conversationListInfiniteQueryKey(assistantId),
    }),
    ...flatConversationQueryKeys(assistantId).map((key) =>
      queryClient.invalidateQueries({ queryKey: key }),
    ),
  ];
  await Promise.all(promises);
}

// ---------------------------------------------------------------------------
// Foreground cache mutations (infinite query)
// ---------------------------------------------------------------------------

/**
 * Apply `updater` to each page's conversations in the foreground infinite
 * query cache. Pages that aren't changed by the updater retain their
 * reference (stable memoization).
 */
export function updateConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  const queryKey = conversationListInfiniteQueryKey(assistantId);
  queryClient.setQueryData<InfiniteData<ConversationPage>>(queryKey, (old) => {
    if (!old) return old;
    let anyPageChanged = false;
    const nextPages = old.pages.map((page) => {
      const updated = updater(page.conversations);
      if (updated === page.conversations) return page;
      anyPageChanged = true;
      return { ...page, conversations: updated };
    });
    if (!anyPageChanged) return old;
    return { ...old, pages: nextPages };
  });
}

/**
 * Prepend a conversation to the first page of the foreground infinite
 * query cache. Used for new draft/conversation insertion.
 */
export function prependToConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): void {
  const queryKey = conversationListInfiniteQueryKey(assistantId);
  queryClient.setQueryData<InfiniteData<ConversationPage>>(queryKey, (old) => {
    if (!old || old.pages.length === 0) {
      return {
        pages: [{ conversations: [conversation], hasMore: false, nextOffset: 1 }],
        pageParams: [0],
      };
    }
    const [firstPage, ...rest] = old.pages;
    return {
      ...old,
      pages: [
        { ...firstPage, conversations: [conversation, ...firstPage.conversations] },
        ...rest,
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Flat cache mutations (background, scheduled, archived)
// ---------------------------------------------------------------------------

function updateFlatCache(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  updater: ConversationUpdater,
): void {
  queryClient.setQueryData<Conversation[]>(queryKey, (prev) => {
    const list = prev ?? [];
    const next = updater(list);
    if (next === list) return prev;
    return next;
  });
}

/**
 * Apply `updater` to the background conversation cache.
 */
export function updateBackgroundConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  updateFlatCache(
    queryClient,
    backgroundConversationsQueryKey(assistantId),
    updater,
  );
}

/**
 * Apply `updater` to the scheduled conversation cache.
 */
export function updateScheduledConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  updateFlatCache(
    queryClient,
    scheduledConversationsQueryKey(assistantId),
    updater,
  );
}

/**
 * Apply `updater` to the archived conversation cache.
 */
export function updateArchivedConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  updateFlatCache(
    queryClient,
    archivedConversationsQueryKey(assistantId),
    updater,
  );
}

/**
 * Apply `updater` to all conversation caches (foreground, background,
 * scheduled, and archived). The caches that don't contain the targeted row
 * return their list unchanged, so the write is a no-op there.
 */
export function updateAllConversationCaches(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  updateConversationsCache(queryClient, assistantId, updater);
  updateBackgroundConversationsCache(queryClient, assistantId, updater);
  updateScheduledConversationsCache(queryClient, assistantId, updater);
  updateArchivedConversationsCache(queryClient, assistantId, updater);
}

// ---------------------------------------------------------------------------
// Cross-cache readers
// ---------------------------------------------------------------------------

/**
 * Read a single conversation from any conversation cache. Used by
 * imperative callers (send pipeline, attention tracking, stream handlers)
 * that need the current value without subscribing to re-renders.
 */
export function findConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
): Conversation | undefined {
  // Search the foreground infinite query cache
  const infiniteData = queryClient.getQueryData<InfiniteData<ConversationPage>>(
    conversationListInfiniteQueryKey(assistantId),
  );
  if (infiniteData) {
    for (const page of infiniteData.pages) {
      const match = page.conversations.find((c) => c.conversationId === key);
      if (match) return match;
    }
  }

  // Search flat caches (background, scheduled, archived)
  for (const queryKey of flatConversationQueryKeys(assistantId)) {
    const match = queryClient
      .getQueryData<Conversation[]>(queryKey)
      ?.find((c) => c.conversationId === key);
    if (match) return match;
  }

  return undefined;
}

/**
 * Merge conversation lists, de-duplicating by `conversationId` (the first
 * list wins on collision). Returns the first list's array reference
 * unchanged when every other list is empty, so the common initial-render
 * case (foreground only) allocates nothing and memoization stays stable.
 */
export function mergeConversationLists(
  ...lists: Conversation[][]
): Conversation[] {
  const [primary = [], ...rest] = lists;
  if (rest.every((list) => list.length === 0)) {
    return primary;
  }
  const seen = new Set(primary.map((c) => c.conversationId));
  const merged = [...primary];
  for (const list of rest) {
    for (const conversation of list) {
      if (seen.has(conversation.conversationId)) {
        continue;
      }
      seen.add(conversation.conversationId);
      merged.push(conversation);
    }
  }
  return merged;
}

/**
 * Read all conversations from every cache, merged and de-duplicated.
 * Returns an empty array when no query has populated yet. The background
 * and scheduled caches are empty until the user reveals their sections, so
 * this transparently falls back to foreground-only during the initial
 * render.
 */
export function getConversations(
  queryClient: QueryClient,
  assistantId: string | null,
): Conversation[] {
  // Foreground from infinite query
  const infiniteData = queryClient.getQueryData<InfiniteData<ConversationPage>>(
    conversationListInfiniteQueryKey(assistantId),
  );
  const foreground = infiniteData
    ? flattenConversationPages(infiniteData.pages)
    : [];

  // Flat caches
  const flatLists = flatConversationQueryKeys(assistantId).map(
    (key) => queryClient.getQueryData<Conversation[]>(key) ?? [],
  );
  return mergeConversationLists(foreground, ...flatLists);
}

/**
 * Immutably patch the conversation matching `key` in whichever cache holds
 * it, leaving all others untouched. No-op when no cache holds the key.
 */
export function patchConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
  patch: Partial<Conversation>,
): void {
  updateAllConversationCaches(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== key) {
        return c;
      }
      changed = true;
      return { ...c, ...patch };
    });
    return changed ? next : conversations;
  });
}
