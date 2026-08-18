/**
 * Low-level read/write helpers over the conversation query caches.
 *
 * Every conversation list cache is one `GET /v1/conversations` read scoped
 * by a {@link ConversationListFilter} and keyed by the generated key for
 * that request (`conversation-list-keys.ts`); the cached value is a
 * `ConversationListPage` (`{conversations, hasMore}`). `hasMore` marks a
 * cache as a *window*, a prefix of the true list whose older rows load on
 * demand; a drained list is a page with nothing beyond it. One shape for
 * both is what keeps every helper here shape-blind: updaters operate on the
 * rows and the window flag rides along.
 *
 * The caches that exist at any moment are whatever filters are mounted:
 *
 * - The four **buckets** (foreground `{}`, background, scheduled, archived):
 *   whole-list reads for the surfaces that need every row of a type.
 *   Foreground gates the initial chat render; the others mount when their
 *   sidebar section or the archive view is revealed.
 * - One **section** cache per sidebar section (a group and/or channel
 *   filter): Pinned, each custom group, each channel, and Chats each key
 *   their own entry. Membership here is the server's answer, not a
 *   client-side filter, so a local change to the fields that filter reads
 *   has to move the row between these caches. See
 *   `utils/section-membership.ts`.
 *
 * A conversation lives in exactly one cache, so the cross-cache helpers
 * (`findConversation`, `getConversations`, `patchConversation`,
 * `updateAllConversationCaches`) discover and operate on every active
 * cache via TanStack Query's partial key matching against the list prefix
 * (`conversationListPrefix`), never a registry. A new filter participates
 * in every cross-cache operation by construction.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 * - https://tanstack.com/query/latest/docs/framework/react/guides/filters#query-filters
 */

import type { QueryClient } from "@tanstack/react-query";

import {
  sidebarSectionsQueryKey,
  unreadConversationCountQueryKey,
} from "@/utils/conversation-list-fetchers";
import {
  type ConversationListFilter,
  conversationListPrefix,
  conversationListQueryKey,
} from "@/utils/conversation-list-keys";
import {
  ensureSectionInIndex,
  patchAffectsMembership,
  reconcileSectionMembership,
} from "@/utils/section-membership";
import type { Conversation } from "@/types/conversation-types";
import type { ConversationListPage } from "@/utils/conversation-list-fetchers";

/**
 * The shape a list cache holds before anything populates it. `hasMore:
 * false` because a cache minted by a local write (a draft, a new
 * conversation) holds everything the client knows; the first real fetch
 * replaces it wholesale.
 */
const EMPTY_PAGE: ConversationListPage = { conversations: [], hasMore: false };

// ---------------------------------------------------------------------------
// Query lifecycle helpers — cancel, snapshot, restore, invalidate
//
// Optimistic updates require a three-step lifecycle:
//   1. Cancel outgoing refetches so they don't overwrite the optimistic value
//   2. Snapshot the current cache for rollback
//   3. After the mutation settles, invalidate so TanStack Query refetches
//
// All these use the shared prefix to discover caches dynamically.
//
// References:
// - https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
// ---------------------------------------------------------------------------

/**
 * Cancel any in-flight refetches for ALL conversation caches. Call this
 * before applying an optimistic update so a concurrent refetch doesn't
 * overwrite the optimistic value with stale server data.
 *
 * Includes the unread-count cache: it lives under its own key (a scalar,
 * not a `Conversation[]`, so it cannot share the list prefix) but is
 * optimistically adjusted by the same seen/unseen mutations.
 */
export async function cancelConversationQueries(
  queryClient: QueryClient,
  assistantId: string,
): Promise<void> {
  await Promise.all([
    queryClient.cancelQueries({
      queryKey: conversationListPrefix(assistantId),
    }),
    queryClient.cancelQueries({
      queryKey: unreadConversationCountQueryKey(assistantId),
    }),
  ]);
}

/**
 * Snapshot of all conversation caches for a given assistant, used for
 * rollback in `onError` after a failed optimistic mutation.
 */
export type ConversationCacheSnapshot = Array<
  [queryKey: readonly unknown[], data: ConversationListPage | undefined]
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
  return queryClient
    .getQueriesData<ConversationListPage>({
      queryKey: conversationListPrefix(assistantId),
    })
    .map(([key, data]) => [key, data]);
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
 *
 * Includes the unread-count cache and the sidebar section index (own keys,
 * see `cancelConversationQueries`) so optimistic count deltas and section
 * existence always reconcile against the authoritative server state after a
 * mutation settles. The index needs the local settle path in particular:
 * the daemon suppresses sync echo to the originating client, so nothing
 * else refreshes it for the client that made the change.
 */
export async function invalidateConversationQueries(
  queryClient: QueryClient,
  assistantId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: conversationListPrefix(assistantId),
    }),
    queryClient.invalidateQueries({
      queryKey: unreadConversationCountQueryKey(assistantId),
    }),
    queryClient.invalidateQueries({
      queryKey: sidebarSectionsQueryKey(assistantId),
    }),
  ]);
}

type ConversationUpdater = (conversations: Conversation[]) => Conversation[];

/**
 * `page` with `updater` applied to its rows, or `page` itself (same
 * reference) when the updater returned the rows unchanged. The one place
 * the row-level updater contract meets the page shape: `hasMore` rides
 * along untouched, and reference identity carries "nothing changed" so
 * callers can skip the write.
 */
function updatePage(
  page: ConversationListPage,
  updater: ConversationUpdater,
): ConversationListPage {
  const next = updater(page.conversations);
  return next === page.conversations
    ? page
    : { conversations: next, hasMore: page.hasMore };
}

function updateCache(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  updater: ConversationUpdater,
): void {
  queryClient.setQueryData<ConversationListPage>(queryKey, (prev) => {
    const page = prev ?? EMPTY_PAGE;
    const next = updatePage(page, updater);
    return next === page ? prev : next;
  });
}

/**
 * Apply `updater` to the one list cache `filter` names. For writes that
 * target a known bucket (draft creation and new-conversation insertion go
 * to the foreground list; a scheduled or background run to its own).
 */
export function updateConversationListCache(
  queryClient: QueryClient,
  assistantId: string | null,
  filter: ConversationListFilter,
  updater: ConversationUpdater,
): void {
  updateCache(
    queryClient,
    conversationListQueryKey(assistantId, filter),
    updater,
  );
}

/**
 * Apply `updater` to ALL active conversation caches for the given
 * assistant. Uses TanStack Query's prefix matching to dynamically
 * discover which caches exist, never a static enumeration. Only caches that
 * TanStack Query is actively tracking are patched; unmounted queries
 * refetch fresh data when they re-mount.
 *
 * The caches that don't contain the targeted row return their list
 * unchanged (the updater is a no-op there). Callers that mutate a row
 * by id without knowing which bucket it belongs to use this.
 */
export function updateAllConversationCaches(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: ConversationUpdater,
): void {
  if (!assistantId) {
    return;
  }
  const entries = queryClient.getQueriesData<ConversationListPage>({
    queryKey: conversationListPrefix(assistantId),
  });
  for (const [queryKey, data] of entries) {
    if (!data) {
      continue;
    }
    const next = updatePage(data, updater);
    if (next !== data) {
      queryClient.setQueryData<ConversationListPage>(queryKey, next);
    }
  }
}

/**
 * Read a single conversation from any active conversation cache. Uses
 * prefix matching to search all caches without static enumeration.
 * Used by imperative callers (send pipeline, attention tracking, stream
 * handlers) that need the current value without subscribing to re-renders.
 */
export function findConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
): Conversation | undefined {
  if (!assistantId) {
    return undefined;
  }
  const entries = queryClient.getQueriesData<ConversationListPage>({
    queryKey: conversationListPrefix(assistantId),
  });
  for (const [, data] of entries) {
    const match = data?.conversations.find((c) => c.conversationId === key);
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
 * Read all conversations from every active cache, merged and
 * de-duplicated. Returns an empty array when no query has populated yet.
 */
export function getConversations(
  queryClient: QueryClient,
  assistantId: string | null,
): Conversation[] {
  if (!assistantId) {
    return [];
  }
  const entries = queryClient.getQueriesData<ConversationListPage>({
    queryKey: conversationListPrefix(assistantId),
  });
  const lists = entries.map(([, data]) => data?.conversations ?? []);
  return mergeConversationLists(...lists);
}

/**
 * Immutably patch the conversation matching `key` in whichever cache holds
 * it, and move it between section caches if the patch changed where it
 * belongs. No-op when no cache holds the key.
 *
 * **Membership is not separable from the fields it is computed from**, which
 * is why the move happens here rather than in a companion helper the callers
 * are expected to also call. A section's contents are a server filter over
 * `groupId` / `isPinned` / `archivedAt` (LUM-2443), so a patch to one of those
 * fields *is* a membership change. Keeping them one operation means a caller
 * that patches a field cannot forget the other half, because there is no other
 * half to call; split apart, the row keeps its old section until a refetch
 * removes it.
 *
 * Patches that touch no membership field (seen state, titles, processing
 * flags, and every bulk path built on them) skip the pass entirely.
 *
 * Returns the section cache keys whose membership actually changed, so a
 * mutation can reconcile exactly those rather than the whole list prefix.
 * Empty for the overwhelmingly common case of a field-only patch.
 */
export function patchConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
  patch: Partial<Conversation>,
): readonly (readonly unknown[])[] {
  // Built once and shared by every cache that holds the key, rather than
  // looked up again afterwards. Sharing the instance is what lets the
  // membership pass tell a cache that already agrees from one that needs
  // rewriting, so sections the patch did not move are not re-rendered.
  let patched: Conversation | undefined;

  updateAllConversationCaches(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== key) {
        return c;
      }
      changed = true;
      patched ??= { ...c, ...patch };
      return patched;
    });
    return changed ? next : conversations;
  });

  if (!patched || !patchAffectsMembership(patch)) {
    return [];
  }
  /* The index decides which sections render, so it is a membership cache
     too: a destination section the index does not know yet must appear with
     the optimistic write, or the row is visible nowhere until the settle
     refetch (the first pin, the first conversation moved into an empty
     group, an unpin returning a channel's only conversation). */
  ensureSectionInIndex(queryClient, assistantId, patched);
  return reconcileSectionMembership(queryClient, assistantId, patched);
}
