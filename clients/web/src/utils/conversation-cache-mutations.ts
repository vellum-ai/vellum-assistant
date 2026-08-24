/**
 * Domain-level cache mutation helpers for conversations and groups.
 *
 * Each function is a thin `queryClient.setQueryData` wrapper so call sites
 * stay declarative. Low-level cache primitives (`updateConversationListCache`,
 * `findConversation`, `patchConversation`) live in `@/utils/conversation-cache`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import { hashKey, type QueryClient } from "@tanstack/react-query";

import type { GroupsGetData } from "@/generated/daemon/types.gen";
import { groupsGetSetQueryData } from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import {
  isBackgroundConversation,
  isScheduledConversation,
} from "@/utils/conversation-predicates";
import { matchesIndexBucket } from "@/utils/section-membership";
import {
  insertByRecency,
  mergeListFirstPage,
} from "@/utils/conversation-order";
import {
  findConversation,
  patchConversation,
  updateAllConversationCaches,
  updateConversationListCache,
} from "@/utils/conversation-cache";
import {
  type ConversationListPage,
  type SidebarIndexSection,
  listConversationsFirstPage,
  listConversationsPage,
  sidebarSectionsQueryKey,
  unreadConversationCountQueryKey,
} from "@/utils/conversation-list-fetchers";
import {
  BACKGROUND_FILTER,
  type ConversationListFilter,
  conversationListFilterOf,
  conversationListPrefix,
  conversationListQueryKey,
  FOREGROUND_FILTER,
  isArchivedFilter,
  isPinnedInjectedFilter,
  SCHEDULED_FILTER,
} from "@/utils/conversation-list-keys";
import {
  ConversationNotFoundError,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";

// ---------------------------------------------------------------------------
// Conversation cache helpers
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

/**
 * Apply a delta to the cached server-side unread conversation count.
 *
 * Optimistic companion to the seen/unseen mutations: a mark-read
 * decrements, a mark-unread increments, and the caller reverts a failed
 * mutation by applying the inverse delta (delta-based reversal, not a
 * snapshot restore, so concurrent adjustments from other in-flight
 * mutations are never clobbered). Drift is reconciled by the authoritative
 * refetch in `invalidateConversationQueries` on settle.
 *
 * **Deliberately unclamped**, so `+n` and `-n` are exact inverses and a
 * revert restores precisely what it took. Clamping here would break that:
 * a decrement that saturated at zero would be undone by more than it
 * removed, leaving the badge over-reporting. The cached value can therefore
 * go briefly negative when optimistic writes outrun the server; presentation
 * clamps it (`useUnreadConversationCount`), which keeps the arithmetic
 * reversible and the display honest.
 *
 * Returns `true` when a numeric count was adjusted. No-ops (returns
 * `false`) when the cache is empty or holds `null` (the connected
 * assistant does not serve the count endpoint).
 */
export function adjustUnreadCountCache(
  queryClient: QueryClient,
  assistantId: string | null,
  delta: number,
): boolean {
  const queryKey = unreadConversationCountQueryKey(assistantId);
  const current = queryClient.getQueryData<number | null>(queryKey);
  if (typeof current !== "number") {
    return false;
  }
  queryClient.setQueryData<number | null>(queryKey, current + delta);
  return true;
}

/**
 * Apply a delta to one section's `unread` in the cached sidebar section
 * index. Optimistic companion to {@link adjustUnreadCountCache}: wherever a
 * seen/unseen mutation adjusts the global count for a row, the row's own
 * section adjusts by the same delta, so the collapsed dot answers with the
 * badge instead of one settle refetch behind it.
 *
 * The bucket mirrors the daemon's section aggregation: pinned wins, then a
 * custom group, then the effective origin channel with NULL reading as
 * native (the Chats bucket). Deliberately unclamped like the global count,
 * so `+n` and `-n` are exact inverses; the dot lights on `> 0`, which reads
 * a briefly negative value as dark.
 *
 * Returns `true` when a bucket row was adjusted. No-ops on a `null` index
 * (assistant without the endpoint), an unfetched index, or a bucket the
 * index does not carry; the settle refetch reconciles those.
 */
export function adjustSectionUnreadCache(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
  delta: number,
): boolean {
  const queryKey = sidebarSectionsQueryKey(assistantId);
  const index = queryClient.getQueryData<SidebarIndexSection[] | null>(
    queryKey,
  );
  if (index == null) {
    return false;
  }

  const at = index.findIndex((row) => matchesIndexBucket(conversation, row));
  if (at === -1) {
    return false;
  }
  const next = [...index];
  next[at] = { ...next[at], unread: next[at].unread + delta };
  queryClient.setQueryData<SidebarIndexSection[] | null>(queryKey, next);
  return true;
}

export function prependConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): void {
  updateConversationListCache(
    queryClient,
    assistantId,
    FOREGROUND_FILTER,
    (conversations) => [conversation, ...conversations],
  );
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
 * The list caches that currently hold a conversation, plus the index of
 * that row in each. Used by delete so a failed mutation can put the row
 * back without restoring a whole-page snapshot (which would also rewind
 * concurrent mutations of other conversations in the same cache).
 */
export type ConversationCachePlacement = {
  queryKey: readonly unknown[];
  index: number;
};

export function recordConversationPlacements(
  queryClient: QueryClient,
  assistantId: string | null,
  conversationId: string,
): ConversationCachePlacement[] {
  if (!assistantId) {
    return [];
  }
  const placements: ConversationCachePlacement[] = [];
  const entries = queryClient.getQueriesData<ConversationListPage>({
    queryKey: conversationListPrefix(assistantId),
  });
  for (const [queryKey, data] of entries) {
    const index = data?.conversations.findIndex(
      (c) => c.conversationId === conversationId,
    );
    if (index === undefined || index < 0) {
      continue;
    }
    placements.push({ queryKey, index });
  }
  return placements;
}

/**
 * Re-insert a removed conversation into the caches that held it, at the
 * recorded index. Skips a cache that already has the row or is no longer
 * mounted. Other rows in those caches are left as they are.
 */
export function restoreRemovedConversation(
  queryClient: QueryClient,
  conversation: Conversation,
  placements: readonly ConversationCachePlacement[],
): void {
  for (const { queryKey, index } of placements) {
    const page = queryClient.getQueryData<ConversationListPage>(queryKey);
    if (!page) {
      continue;
    }
    if (
      page.conversations.some(
        (c) => c.conversationId === conversation.conversationId,
      )
    ) {
      continue;
    }
    const next = [...page.conversations];
    const insertAt = Math.min(Math.max(index, 0), next.length);
    next.splice(insertAt, 0, conversation);
    queryClient.setQueryData<ConversationListPage>(queryKey, {
      ...page,
      conversations: next,
    });
  }
}

export function shouldSurfaceConversation(conversation: Conversation): boolean {
  if (conversation.archivedAt != null) {
    return false;
  }
  /* The daemon's surfaced visibility arm excludes subagent runs, so a
     surface can never make one listable; firing it would insert a row the
     next refetch drops. Mirrors `isSidebarVisible` and
     `surfacedVisibilitySql`. */
  if (conversation.source === "subagent") {
    return false;
  }
  if (conversation.surfacedAt != null) {
    return false;
  }
  if (
    conversation.isPinned === true ||
    conversation.groupId === "system:pinned"
  ) {
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

/**
 * Write a just-surfaced conversation into the caches for the open path.
 *
 * Differs from {@link surfaceConversationInCaches} (the send path) on the
 * two axes where a bare surface differs from a send: the server writes only
 * `surfaced_at` on surface, so neither `lastMessageAt` nor `groupId` moves,
 * and the row takes its recency position rather than the top of the list.
 *
 * The row reaches the foreground cache if no list held it yet (a background
 * run opened from the activity feed lives in the background cache at most),
 * because the foreground cache is the standard listing and a surfaced row
 * belongs to it. Section membership and the index stub ride
 * `patchConversation`, which `surfacedAt` triggers as a membership field.
 */
export function applySurfacedConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
  surfacedAt: number,
): void {
  /* The caller captured `conversation` before its POST left, and other
     writes land while the request is out: mark-seen-on-open fires from the
     same render and patches the row's seen state. Inserting the captured
     snapshot would replay those fields backwards, and the membership pass
     would spread the resurrected values into every section cache. The
     freshest cached row wins; the snapshot is only the fallback when no
     cache holds the row at all. */
  const latest =
    findConversation(queryClient, assistantId, conversation.conversationId) ??
    conversation;
  const surfaced: Conversation = { ...latest, surfacedAt };
  updateConversationListCache(
    queryClient,
    assistantId,
    FOREGROUND_FILTER,
    (conversations) =>
      conversations.some(
        (c) => c.conversationId === conversation.conversationId,
      )
        ? conversations
        : insertByRecency(conversations, surfaced),
  );
  patchConversation(queryClient, assistantId, conversation.conversationId, {
    surfacedAt,
  });
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

  updateAllConversationCaches(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== conversation.conversationId) {
        return c;
      }
      changed = true;
      return surfacedConversation;
    });
    return changed ? next : conversations;
  });

  updateConversationListCache(
    queryClient,
    assistantId,
    FOREGROUND_FILTER,
    (conversations) => [
      surfacedConversation,
      ...conversations.filter(
        (c) => c.conversationId !== conversation.conversationId,
      ),
    ],
  );
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
  if (!assistantId) {
    return;
  }

  let result: Conversation;
  try {
    result = await fetchConversationDetail(
      queryClient,
      assistantId,
      conversationId,
    );
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
    updateConversationListCache(
      queryClient,
      assistantId,
      SCHEDULED_FILTER,
      (conversations) => [...conversations, result],
    );
    return;
  }
  if (isBackgroundConversation(result)) {
    updateConversationListCache(
      queryClient,
      assistantId,
      BACKGROUND_FILTER,
      (conversations) => [...conversations, result],
    );
    return;
  }
  updateConversationListCache(
    queryClient,
    assistantId,
    FOREGROUND_FILTER,
    (conversations) => [...conversations, result],
  );
}

/**
 * Refresh the top window of every populated conversation-list cache with a
 * single first-page GET per cache, merging via {@link mergeListFirstPage}.
 *
 * Covers every tracked list cache, bucket or section, discovered through
 * the list prefix and read back to the filter each was fetched with (the
 * filter is the key's `query`). A section cache is a *window* (LUM-2444):
 * its plain refetch is one first-page GET, but that refetch would also
 * replace the whole window with page one, throwing away every load-more
 * page the user scrolled in. Merging here keeps the loaded window and
 * refreshes its top, so a signal costs one request per cache and loses
 * nothing.
 *
 * The archived caches are the exception and stay on plain invalidation
 * (`use-conversation-sync.ts`): they are ordered by `archivedAt`, while
 * every daemon page is recency-ordered and the merge's window cutoff is a
 * recency axis, so a merged archived list would come out mis-ordered.
 *
 * Drives the `conversationsList` sync-tag and SSE-reconnect handlers in
 * `use-conversation-sync.ts`. The full list query drains every page
 * (hundreds of sequential GETs at thousands of conversations), so
 * invalidating it on each sync signal exhausts the daemon's per-client
 * rate-limit budget during active turns; refreshing just the visible
 * window keeps the cost bounded.
 *
 * A tracked cache holding no data cannot be window-merged, and it must not
 * be skipped either: a query whose first fetch failed sits exactly there,
 * and a sync signal is its retry path. Those caches are invalidated
 * instead, which refetches the active ones and leaves disabled or
 * unmounted ones stale for their next mount. A cache mid-fetch is left
 * alone so a burst of signals cannot cancel and restart a first load that
 * is already running. Untracked keys (a section never expanded) stay
 * untouched: their queries fetch on first expand anyway.
 *
 * Fetch errors are rethrown so the caller can log/capture without silently
 * dropping the signal.
 */
export async function refreshConversationListWindows(
  queryClient: QueryClient,
  assistantId: string | null,
): Promise<void> {
  if (!assistantId) {
    return;
  }

  /* One refresh decision for every tracked list cache, bucket or section. */
  const refresh = async (
    queryKey: readonly unknown[],
    fetchStatus: "fetching" | "paused" | "idle",
    fetchFirstPage: () => Promise<ConversationListPage>,
    pinnedInjected: boolean,
  ): Promise<void> => {
    /* Read fresh here rather than passed in from discovery, so the
       reference below describes the cache as of the moment the request
       leaves, not as of when the caches were enumerated. */
    const before = queryClient.getQueryData<ConversationListPage>(queryKey);
    if (before === undefined) {
      if (fetchStatus === "idle") {
        /* Exact: this cache alone. As a partial filter the foreground key
           (`query: {}`) would match every list cache. */
        await queryClient.invalidateQueries({ queryKey, exact: true });
      }
      return;
    }
    const page = await fetchFirstPage();
    /* Identity, not a timestamp. This fetch runs outside TanStack, so
       nothing that protects the cache from in-flight *queries* protects it
       from this response: an optimistic placement's `cancelQueries` cannot
       cancel it, and a second refresh cannot dedupe against it. Any write
       that lands while the request is in flight (an optimistic move, a
       newer refresh, a real refetch) replaces the array, so a changed
       reference marks this response as the older account of the cache and
       it is dropped rather than merged. `dataUpdatedAt` cannot carry this
       check: it has millisecond resolution, and a write landing in the
       same millisecond the reference was captured would be invisible to
       it. The writer that outran the response carries its own
       reconciliation; the next sync signal re-refreshes regardless. */
    if (queryClient.getQueryData<ConversationListPage>(queryKey) !== before) {
      return;
    }
    queryClient.setQueryData<ConversationListPage>(
      queryKey,
      (prev: ConversationListPage | undefined) =>
        prev === undefined
          ? undefined
          : mergeListFirstPage(prev, page, { pinnedInjected }),
    );
  };

  const refreshes = queryClient
    .getQueryCache()
    .findAll({ queryKey: conversationListPrefix(assistantId) })
    .map(async (query) => {
      const filter = conversationListFilterOf(query.queryKey);
      if (!filter || isArchivedFilter(filter)) {
        return;
      }
      await refresh(
        query.queryKey,
        query.state.fetchStatus,
        () => listConversationsFirstPage(assistantId, filter),
        isPinnedInjectedFilter(filter),
      );
    });

  await Promise.all(refreshes);
}

export function resolveDraftKey(
  queryClient: QueryClient,
  assistantId: string | null,
  oldKey: string,
  newKey: string,
): void {
  updateConversationListCache(
    queryClient,
    assistantId,
    FOREGROUND_FILTER,
    (conversations) => {
      let changed = false;
      const next = conversations.map((c) => {
        if (c.conversationId !== oldKey) {
          return c;
        }
        changed = true;
        return { ...c, conversationId: newKey, draft: false };
      });
      return changed ? next : conversations;
    },
  );
}

// ---------------------------------------------------------------------------
// Group cache helpers
// ---------------------------------------------------------------------------

function updateGroupsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: (groups: ConversationGroup[]) => ConversationGroup[],
): void {
  const opts: Options<GroupsGetData> = {
    path: { assistant_id: assistantId ?? "" },
  };
  groupsGetSetQueryData(queryClient, opts, (prev) => {
    const list = prev?.groups ?? [];
    const next = updater(list);
    if (next === list) {
      return prev;
    }
    return { ...prev, groups: next };
  });
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
      sortPosition: group.sortPosition ?? groups.length,
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
      if (g.id !== groupId) {
        return g;
      }
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
      if (g.id !== optimisticId) {
        return g;
      }
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

/**
 * Section load-mores in flight, keyed by the section's query key hash. One
 * request per section at a time: the sentinel that triggers a load-more
 * stays visible (and re-firing) until rows arrive, and without the guard a
 * scroll wiggle issues the same offset fetch several times over.
 *
 * Module-level because the callers are imperative and share no React
 * context; the alternative, TanStack's own dedupe through `fetchQuery`,
 * would need a per-offset query key for a page that is appended into
 * another key's cache rather than owned by its own.
 */
const loadsInFlight = new Set<string>();

/**
 * Extend a windowed list cache by one page.
 *
 * The offset is the cache's current row count at request time, not a stored
 * cursor: optimistic writes add and remove rows, and a frozen cursor would
 * refetch rows the cache already holds or skip past ones it lost. Fresh rows
 * are deduped by id before appending, so overlap from rows that moved while
 * the request was in flight cannot double-render.
 *
 * The append is guarded by cache identity, exactly like the window refresh
 * above: this fetch runs outside TanStack, so a write landing mid-flight
 * (an optimistic move, a sync merge) replaces the page object, and this
 * response would be appending to rows that no longer exist. Dropping it is
 * cheap because the sentinel is still visible: it re-fires against the new
 * cache, with the offset that cache implies.
 *
 * No-op when the cache is absent (nothing to extend) or already complete.
 */
export async function loadMoreConversations(
  queryClient: QueryClient,
  assistantId: string,
  filter: ConversationListFilter,
): Promise<void> {
  const queryKey = conversationListQueryKey(assistantId, filter);
  const guardKey = hashKey(queryKey);
  if (loadsInFlight.has(guardKey)) {
    return;
  }
  const before = queryClient.getQueryData<ConversationListPage>(queryKey);
  if (!before || !before.hasMore) {
    return;
  }
  loadsInFlight.add(guardKey);
  try {
    const page = await listConversationsPage(
      assistantId,
      filter,
      before.conversations.length,
    );
    if (queryClient.getQueryData<ConversationListPage>(queryKey) !== before) {
      return;
    }
    const held = new Set(before.conversations.map((c) => c.conversationId));
    const fresh = page.conversations.filter((c) => !held.has(c.conversationId));
    queryClient.setQueryData<ConversationListPage>(queryKey, {
      conversations: [...before.conversations, ...fresh],
      hasMore: page.hasMore,
    });
  } finally {
    loadsInFlight.delete(guardKey);
  }
}
