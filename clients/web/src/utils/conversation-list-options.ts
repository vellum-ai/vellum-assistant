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
 *   drain because their readers assume a complete list; a bucket becomes
 *   windowed only when its readers stop needing every row, never as a side
 *   effect of the key.
 *
 * The transform runs in the queryFn, so the cache holds `Conversation` and
 * not the wire shape. That is a documented TanStack option with a named
 * cost: the raw response is not available from the cache, so the generated
 * `SetQueryData` helpers for this route do not apply. The constraint that
 * forces it is the placement seam: it mints rows optimistically
 * (`prependConversation`, `surfaceConversationInCaches`) and there is no
 * `Conversation` -> wire inverse, so the cache cannot hold the wire shape
 * while the client authors rows. A seam that applies server-returned rows
 * lets the transform move to `select`.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/query-options}
 * @see {@link https://tkdodo.eu/blog/react-query-data-transformations}
 */

import { queryOptions } from "@tanstack/react-query";

import { conversationsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  type ConversationListFilter,
  type ConversationListQueryKey,
  FOREGROUND_FILTER,
  isPinnedInjectedFilter,
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
  /* The generated factory is the route contract, and its key is what this
     cache is filed under. Its `queryFn` is not reused: it returns the wire
     page for one offset, typed as `ConversationsGetResponse` through every
     TanStack option slot (`select`, `initialData`, `placeholderData`), so
     the object cannot be spread under a `queryFn` that returns
     `ConversationListPage`; the key is taken from it and the query function
     is this module's. */
  const queryKey: ConversationListQueryKey = conversationsGetOptions({
    path: { assistant_id: assistantId },
    query: filter,
  }).queryKey;
  if (isSectionFilter(filter)) {
    return queryOptions({
      queryKey,
      queryFn: async ({ client }) => {
        const page = await listConversationsFirstPage(assistantId, filter);
        const prev = client.getQueryData<ConversationListPage>(queryKey);
        return prev
          ? mergeListFirstPage(prev, page, {
              pinnedInjected: isPinnedInjectedFilter(filter),
            })
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
