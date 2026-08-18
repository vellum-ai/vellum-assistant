/**
 * Query options for the conversation list caches: one factory over the
 * generated `conversationsGet` request, keyed by the generated key.
 *
 * A conversation list cache is a `GET /v1/conversations` read scoped by a
 * filter, so its options are the generated request with two additions the
 * app needs and the codegen cannot know: the rows are `Conversation` (the
 * wire row through `toConversation`), and the cached value is a
 * {@link ConversationListPage} whose `hasMore` says whether the cache is a
 * window onto a longer list. That value shape is what the placement seam
 * writes and every reader expects; keeping it here means one factory
 * serves every list read.
 *
 * Two loading modes, and which one a filter gets is decided here rather
 * than by the caller:
 *
 * - **Windowed**: one page on mount, more on scroll
 *   (`loadMoreConversations`), sync and settle refreshes merge a
 *   fresh first page over the window (`mergeListFirstPage`). Every
 *   section (a filter on the group or channel axis) is windowed.
 * - **Drained**: every page fetched serially, `hasMore: false` at rest.
 *   The four bucket reads (foreground, background, scheduled, archived)
 *   still drain because their remaining readers assume a complete list;
 *   they stop draining as those readers move to server answers, not as a
 *   side effect of a key change.
 *
 * The transform runs in the queryFn, so the cache holds `Conversation` and
 * not the wire shape. That is a documented TanStack option with a named
 * cost: the raw response is not available from the cache, so the generated
 * `SetQueryData` helpers for this route do not apply. It is kept for now
 * because the placement seam mints rows optimistically (`prependConversation`,
 * `surfaceConversationInCaches`) and there is no `Conversation` -> wire
 * inverse; once mutation responses carry the row's post-state the seam
 * applies server rows and the transform moves to `select`.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/query-options}
 * @see {@link https://tkdodo.eu/blog/react-query-data-transformations}
 */

import { queryOptions } from "@tanstack/react-query";

import {
  type ConversationListFilter,
  conversationListQueryKey,
  FOREGROUND_FILTER,
  isSectionFilter,
} from "@/utils/conversation-list-keys";
import {
  type ConversationListPage,
  drainConversationList,
  listConversationsFirstPage,
} from "@/utils/conversation-list-fetchers";
import { mergeListFirstPage } from "@/utils/conversation-order";

const QUERY_STALE_TIME_MS = 30_000;

/**
 * Query options for one conversation list cache.
 *
 * Spread into `useQuery()` and set `enabled` at the hook. Sections
 * (group/channel filters) are windowed; the buckets drain. The windowed
 * queryFn is *window-preserving*: a plain refetch (focus past staleTime,
 * a settle invalidation) merges the fresh first page over the cached
 * window rather than replacing it, so a scrolled-in window is never
 * truncated to page one under the user's scrollbar. The cache is read
 * through the query function's own context (`client`, `queryKey`), so the
 * factory is keyed by request identity alone.
 */
export function conversationListOptions(
  assistantId: string,
  filter: ConversationListFilter = FOREGROUND_FILTER,
) {
  const queryKey = conversationListQueryKey(assistantId, filter);
  if (isSectionFilter(filter)) {
    return queryOptions({
      queryKey,
      queryFn: async ({ client }) => {
        const page = await listConversationsFirstPage(assistantId, filter);
        const prev = client.getQueryData<ConversationListPage>(queryKey);
        /* A section page has no daemon pinned-row injection; see
           mergeListFirstPage. */
        return prev
          ? mergeListFirstPage(prev, page, { pinnedInjected: false })
          : page;
      },
      staleTime: QUERY_STALE_TIME_MS,
    });
  }
  return queryOptions({
    queryKey,
    queryFn: async (): Promise<ConversationListPage> => ({
      conversations: await drainConversationList(assistantId, filter),
      hasMore: false,
    }),
    staleTime: QUERY_STALE_TIME_MS,
  });
}
