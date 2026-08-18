/**
 * Query keys for the conversation list caches: the generated
 * `conversationsGetQueryKey`, and nothing else.
 *
 * Every conversation list cache is a `GET /v1/conversations` read scoped by
 * its filter, so its key is the generated key for that request:
 * `[{ _id: "conversationsGet", path: { assistant_id }, query: <filter> }]`.
 * The four bucket caches (foreground, background, scheduled, archived) and
 * the per-section caches are all this one key with different `query`
 * values; there is no second key scheme.
 *
 * Two facts about the generated key shape decide how it is used, both
 * verified by executing `partialMatchKey` against the generated functions
 * rather than by reading about them:
 *
 * 1. **The key without `query` is the prefix.** `partialMatchKey` matches
 *    an object key when every property of the filter is deep-equal in the
 *    candidate, so `{ _id, path }` matches every list read for that
 *    assistant and rejects the by-id detail (`conversationsByIdGet`), the
 *    section index, the unread count, and every other assistant. That is
 *    the whole "prefix scan" the cross-cache helpers depend on, provided by
 *    TanStack rather than by a hand-rolled key layout.
 * 2. **A cache's own key must carry `query`, even when empty.** The prefix
 *    `{ _id, path }` and the foreground list's key `{ _id, path, query: {} }`
 *    are different keys. If the foreground list were keyed by the bare
 *    prefix, a prefix scan would find that entry as a phantom list. So
 *    {@link conversationListQueryKey} always writes a `query` object, and
 *    {@link conversationListPrefix} never does.
 * 3. **The same partial matching cuts the other way.** A cache key used as
 *    a `queryClient` *filter* (`invalidateQueries`, `cancelQueries`) matches
 *    every key its `query` is a subset of, so the foreground key
 *    `{ query: {} }` would match every list cache. Read and write one cache
 *    by its key (`getQueryData`, `setQueryData`, exact by construction);
 *    to filter to one cache pass `exact: true`; to filter to a subset use
 *    {@link conversationListQueryFilter}.
 *
 * `limit` and `offset` are deliberately not part of the key. The key names
 * the filter; pagination lives inside the cached page (`hasMore` and the
 * rows loaded so far), so a load-more extends one cache entry rather than
 * minting one per page.
 *
 * `select`-side transforms and the page shape the cache holds are
 * documented on the options factories, not here.
 */

import { partialMatchKey, type QueryFilters } from "@tanstack/react-query";

import { conversationsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ConversationsGetData } from "@/generated/daemon/types.gen";

/**
 * The filter a conversation list cache is keyed by: the route's query
 * parameters minus pagination. Absent means "no constraint on that axis",
 * exactly as the route reads it, so the foreground list is `{}`.
 */
export type ConversationListFilter = Omit<
  NonNullable<ConversationsGetData["query"]>,
  "limit" | "offset"
>;

/**
 * Filters for the four bucket reads: whole-list reads for the surfaces that
 * need every row of a type. Named so callers spread the same object and get
 * the same key; each is one `conversationsGet` request scoped by these
 * params.
 */
export const FOREGROUND_FILTER: ConversationListFilter = {};
export const BACKGROUND_FILTER: ConversationListFilter = {
  conversationType: "background",
};
export const SCHEDULED_FILTER: ConversationListFilter = {
  conversationType: "scheduled",
};
export const ARCHIVED_FILTER: ConversationListFilter = {
  archiveStatus: "archived",
};
/**
 * The archived view shows archived rows of every type, and the route's
 * `conversationType` defaults to standard with no "all" value, so archived
 * background rows are a second request. It is its own cache, keyed by its
 * own filter, and the archive page merges the two at the consumer; there is
 * no honest single key for a client-side union of two requests.
 */
export const ARCHIVED_BACKGROUND_FILTER: ConversationListFilter = {
  archiveStatus: "archived",
  conversationType: "background",
};

/** The `_id` the generated key stamps on every list read, read off the key itself. */
const LIST_OPERATION_ID = conversationsGetQueryKey({
  path: { assistant_id: "" },
})[0]._id;

/** The generated key type for one list cache; what `partialMatchKey` walks. */
export type ConversationListQueryKey = ReturnType<
  typeof conversationsGetQueryKey
>;

/**
 * Key for one conversation list cache. Always carries `query`, so it is a
 * member of the prefix and never equal to it (see the module doc, fact 2).
 */
export function conversationListQueryKey(
  assistantId: string | null,
  filter: ConversationListFilter = {},
): ConversationListQueryKey {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
    query: filter,
  });
}

/**
 * Prefix matching every conversation list cache for one assistant, and
 * nothing else that shares its `assistant_id` path. Pass to `queryClient`
 * filters (`getQueriesData`, `cancelQueries`, `invalidateQueries`) and to
 * {@link isConversationListKey}.
 */
export function conversationListPrefix(
  assistantId: string | null,
): ConversationListQueryKey {
  return conversationsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  });
}

/**
 * Whether `queryKey` is one assistant's conversation list cache. The
 * predicate a query-cache subscriber uses to ignore unrelated traffic.
 */
export function isConversationListKey(
  queryKey: readonly unknown[],
  assistantId: string | null,
): boolean {
  return partialMatchKey(queryKey, conversationListPrefix(assistantId));
}

/**
 * The filter a conversation list cache was keyed by, read straight off the
 * generated key. `undefined` when the key is not a list key.
 *
 * Exists because a membership-aware write has to answer "does this row
 * belong in *this* cache", and the only statement of what a cache holds is
 * its key: TanStack's `setQueriesData` hands an updater the data alone, so
 * the write walks `getQueriesData` and reads each key. With the generated
 * key that read is a property access, not a positional decode.
 *
 * @see {@link https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientsetqueriesdata}
 */
export function conversationListFilterOf(
  queryKey: readonly unknown[],
): ConversationListFilter | undefined {
  const head = queryKey[0];
  if (
    typeof head !== "object" ||
    head === null ||
    (head as { _id?: unknown })._id !== LIST_OPERATION_ID
  ) {
    return undefined;
  }
  const query = (head as { query?: unknown }).query;
  /* A key with no `query` is the prefix, not a cache (module doc, fact 2). */
  if (typeof query !== "object" || query === null) {
    return undefined;
  }
  return query as ConversationListFilter;
}

/**
 * A `queryClient` filter selecting the subset of one assistant's list
 * caches whose filter satisfies `matches`: the prefix narrows to list
 * caches and the predicate reads each key's filter, and TanStack applies
 * both. For "invalidate every section" or "every archived list" without
 * enumerating keys.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/filters#query-filters}
 */
export function conversationListQueryFilter(
  assistantId: string | null,
  matches: (filter: ConversationListFilter) => boolean,
): QueryFilters {
  return {
    queryKey: conversationListPrefix(assistantId),
    predicate: (query) => {
      const filter = conversationListFilterOf(query.queryKey);
      return filter !== undefined && matches(filter);
    },
  };
}

/**
 * Whether a list filter names a sidebar section (as opposed to a whole
 * bucket): any filter constrained on the group or channel axis. The
 * placement seam moves rows between section caches only.
 */
export function isSectionFilter(filter: ConversationListFilter): boolean {
  return filter.groupId !== undefined || filter.originChannel !== undefined;
}

/** Whether a list filter names an archived list (the archive view's reads). */
export function isArchivedFilter(filter: ConversationListFilter): boolean {
  return filter.archiveStatus === "archived";
}

/**
 * Whether the daemon appends every pinned row to this filter's first page.
 * True for exactly one read, the fully unfiltered foreground list (every
 * axis at its default); every scoped read gets the filtered page alone.
 * Mirrors the guard in the daemon's `handleListConversations`, the
 * compatibility shim for clients that read Pinned out of the unfiltered
 * list, and matters to `mergeListFirstPage`, which must keep the
 * injected rows out of its window cutoff.
 */
export function isPinnedInjectedFilter(
  filter: ConversationListFilter,
): boolean {
  return (
    filter.conversationType === undefined &&
    (filter.archiveStatus === undefined || filter.archiveStatus === "active") &&
    filter.originChannel === undefined &&
    filter.groupId === undefined &&
    filter.needsAttention === undefined &&
    filter.foregroundOnly === undefined
  );
}
