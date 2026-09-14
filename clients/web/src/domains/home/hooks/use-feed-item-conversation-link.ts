/**
 * Resolves the "Go to Conversation" target for one feed item.
 *
 * Sidebar list membership is the wrong existence check: scheduled and
 * background runs are stripped from the foreground list, the background drain
 * drops scheduled rows, and a conversation that is archived or simply not in
 * the drained window looks deleted. The by-id read is the same answer the
 * chat route uses, so a scheduled inbox-pass card can still open its thread.
 *
 * A 404 drops the link. Any other failure keeps it: the feed already named
 * the conversation, and the chat route handles a dead id.
 */
import { useQuery } from "@tanstack/react-query";

import { conversationsByIdGet } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export interface FeedItemConversationLinkResult {
  /**
   * Id to open, or `null` when the item names none or the by-id read 404ed.
   * While the read is in flight this is the candidate id, so the footer can
   * hold the button's box until validation lands.
   */
  conversationId: string | null;
  /** True while the by-id read this item actually depends on is in flight. */
  isPending: boolean;
}

/**
 * Map one by-id read onto the footer link. Exported so the pending / 404 /
 * error cases can be asserted without mounting the query.
 */
export function resolveConversationLink(args: {
  itemConversationId: string | null;
  enabled: boolean;
  isPending: boolean;
  isError: boolean;
  /** `false` when the by-id read 404ed. `true` when it returned a row. */
  exists: boolean;
}): FeedItemConversationLinkResult {
  const { itemConversationId, enabled, isPending, isError, exists } = args;
  if (!itemConversationId || !enabled) {
    return { conversationId: null, isPending: false };
  }
  if (isPending) {
    return { conversationId: itemConversationId, isPending: true };
  }
  if (isError || exists) {
    return { conversationId: itemConversationId, isPending: false };
  }
  return { conversationId: null, isPending: false };
}

/**
 * Resolve the conversation a feed item opens, validated by id rather than by
 * sidebar list membership.
 *
 * `enabled` gates the fetch. The bell renders in the top bar on every route
 * and passes `false` until a detail is open, so its list view costs nothing.
 */
export function useFeedItemConversationLink(
  itemConversationId: string | null,
  assistantId: string | null | undefined,
  enabled: boolean,
): FeedItemConversationLinkResult {
  const conversationId = itemConversationId;
  const canFetch =
    enabled && Boolean(assistantId) && Boolean(conversationId);

  // Own cache, not the conversation-detail key: a 404 here is `false`, and
  // other readers of `conversationsByIdGet` expect a row.
  const query = useQuery({
    queryKey: [
      "feedItemConversationLink",
      assistantId ?? "",
      conversationId ?? "",
    ],
    enabled: canFetch,
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data, error, response } = await conversationsByIdGet({
        path: {
          assistant_id: assistantId ?? "",
          id: conversationId ?? "",
        },
        throwOnError: false,
        signal,
      });
      if (response?.status === 404) {
        return false;
      }
      assertHasResponse(response, error, "Failed to fetch conversation.");
      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, "Failed to fetch conversation."),
        );
      }
      return data?.conversation != null;
    },
  });

  return resolveConversationLink({
    itemConversationId: conversationId,
    enabled: canFetch,
    isPending: query.isPending,
    isError: query.isError,
    exists: query.data === true,
  });
}
