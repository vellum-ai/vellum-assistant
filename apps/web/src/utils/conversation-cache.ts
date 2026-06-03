/**
 * Low-level read/write helpers over the conversation query caches.
 *
 * Conversations are split across three flat `Conversation[]` caches:
 *
 * - **Foreground** under `conversationsQueryKey` — the primary list that
 *   gates the initial chat render. Always fetched.
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
 * a no-op. This lets every mutation, stream handler, and attention sweep
 * keep a single call site regardless of which bucket a conversation
 * belongs to.
 *
 * These primitives are shared cross-domain; `queryClient.setQueryData` /
 * `getQueryData` is an implementation detail callers shouldn't repeat.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import type { QueryClient } from "@tanstack/react-query";

import {
  archivedConversationsQueryKey,
  backgroundConversationsQueryKey,
  conversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import type { Conversation } from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Query lifecycle helpers — cancel, snapshot, restore, invalidate
//
// Optimistic updates require a three-step lifecycle:
//   1. Cancel outgoing refetches so they don't overwrite the optimistic value
//   2. Snapshot the current cache for rollback
//   3. After the mutation settles, invalidate so TanStack Query refetches
//
// References:
// - https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
// ---------------------------------------------------------------------------

/** All conversation query keys for the given assistant. */
function allConversationQueryKeys(assistantId: string | null) {
  return [
    conversationsQueryKey(assistantId),
    backgroundConversationsQueryKey(assistantId),
    scheduledConversationsQueryKey(assistantId),
    archivedConversationsQueryKey(assistantId),
  ] as const;
}

/**
 * Cancel any in-flight refetches for conversation caches. Call this before
 * applying an optimistic update so a concurrent refetch doesn't overwrite
 * the optimistic value with stale server data.
 */
export async function cancelConversationQueries(
  queryClient: QueryClient,
  assistantId: string,
): Promise<void> {
  await Promise.all(
    allConversationQueryKeys(assistantId).map((key) =>
      queryClient.cancelQueries({ queryKey: key }),
    ),
  );
}

/**
 * Snapshot of all conversation caches for a given assistant, used for
 * rollback in `onError` after a failed optimistic mutation.
 */
export type ConversationCacheSnapshot = Array<
  [queryKey: readonly unknown[], data: Conversation[] | undefined]
>;

/**
 * Capture the current state of all conversation caches. The returned
 * snapshot can be passed to `restoreConversationCaches` to undo an
 * optimistic update.
 */
export function snapshotConversationCaches(
  queryClient: QueryClient,
  assistantId: string,
): ConversationCacheSnapshot {
  return allConversationQueryKeys(assistantId).map((key) => [
    key,
    queryClient.getQueryData<Conversation[]>(key),
  ]);
}

/**
 * Restore conversation caches from a snapshot, undoing an optimistic update.
 */
export function restoreConversationCaches(
  queryClient: QueryClient,
  snapshot: ConversationCacheSnapshot,
): void {
  for (const [key, data] of snapshot) {
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
  await Promise.all(
    allConversationQueryKeys(assistantId).map((key) =>
      queryClient.invalidateQueries({ queryKey: key }),
    ),
  );
}

type ConversationUpdater = (conversations: Conversation[]) => Conversation[];

function updateCache(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  updater: ConversationUpdater,
): void {
  queryClient.setQueryData<Conversation[]>(queryKey, (prev) => {
    const list = prev ?? [];
    const next = updater(list);
    if (next === list) {
      return prev;
    }
    return next;
  });
}

/**
 * Apply `updater` to the foreground conversation cache. Used for writes
 * that only ever target foreground rows (draft creation, new-conversation
 * insertion).
 */
export function updateConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  updateCache(queryClient, conversationsQueryKey(assistantId), updater);
}

/**
 * Apply `updater` to the background conversation cache.
 */
export function updateBackgroundConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  updateCache(
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
  updateCache(
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
  updateCache(
    queryClient,
    archivedConversationsQueryKey(assistantId),
    updater,
  );
}

/**
 * Apply `updater` to all conversation caches (foreground, background,
 * scheduled, and archived). The caches that don't contain the targeted row
 * return their list unchanged, so the write is a no-op there. Callers that
 * mutate a row by id without knowing which bucket a conversation belongs to
 * use this.
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
  for (const queryKey of allConversationQueryKeys(assistantId)) {
    const match = queryClient
      .getQueryData<Conversation[]>(queryKey)
      ?.find((c) => c.conversationId === key);
    if (match) {
      return match;
    }
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
  const lists = allConversationQueryKeys(assistantId).map(
    (key) => queryClient.getQueryData<Conversation[]>(key) ?? [],
  );
  return mergeConversationLists(...lists);
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
