/**
 * The single write path for marking a conversation seen.
 *
 * Two entry points share it: the explicit "Mark as read" menu action, and the
 * effect that marks a conversation seen when the user opens it. One mutation
 * means one optimistic contract instead of per-caller reimplementations that
 * drift apart:
 *
 *   onMutate  → cancel in-flight refetches, snapshot, patch the row seen,
 *               decrement the server-side unread count when the row counted
 *   onError   → restore the snapshot and re-apply the inverse count delta
 *   onSettled → invalidate so the server reconciles both
 *
 * The count delta is reverted by its inverse rather than from the snapshot so
 * a concurrent mutation's adjustment is never clobbered.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { conversationsSeenPost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import {
  cancelConversationQueries,
  findConversation,
  invalidateConversationQueries,
  restoreConversationCaches,
  snapshotConversationCaches,
  type ConversationCacheSnapshot,
} from "@/utils/conversation-cache";
import {
  adjustSectionUnreadCache,
  adjustUnreadCountCache,
  markConversationSeenLocal,
} from "@/utils/conversation-cache-mutations";
import { contributesToUnreadCount } from "@/utils/conversation-predicates";
import type { Conversation } from "@/types/conversation-types";

export interface MarkConversationSeenVars {
  assistantId: string;
  conversationId: string;
}

interface MarkSeenContext {
  snapshot: ConversationCacheSnapshot;
  /** `-1` when the row was counted toward the unread badge, else `0`. */
  unreadCountDelta: number;
  /**
   * The row as it read when the deltas were applied, kept so `onError` can
   * reverse the per-section adjustment against the same bucket it hit, even
   * if a concurrent move has re-filed the live row since.
   */
  unreadRow?: Conversation;
}

export function useMarkConversationSeenMutation() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, MarkConversationSeenVars, MarkSeenContext>({
    mutationFn: async ({ assistantId, conversationId }) => {
      await conversationsSeenPost({
        path: { assistant_id: assistantId },
        body: { conversationId },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId, conversationId }) => {
      await cancelConversationQueries(queryClient, assistantId);
      const snapshot = snapshotConversationCaches(queryClient, assistantId);

      // Read the row before the patch flips its seen state: only a row that
      // was contributing to the badge should decrement it.
      const row = findConversation(queryClient, assistantId, conversationId);
      const unreadRow =
        row !== undefined && contributesToUnreadCount(row) ? row : undefined;
      const unreadCountDelta = unreadRow ? -1 : 0;
      if (unreadRow) {
        adjustUnreadCountCache(queryClient, assistantId, unreadCountDelta);
        adjustSectionUnreadCache(
          queryClient,
          assistantId,
          unreadRow,
          unreadCountDelta,
        );
      }

      markConversationSeenLocal(queryClient, assistantId, conversationId);
      return { snapshot, unreadCountDelta, unreadRow };
    },
    onError: (err, { assistantId }, context) => {
      if (context?.snapshot) {
        restoreConversationCaches(queryClient, context.snapshot);
      }
      if (context && context.unreadCountDelta !== 0) {
        adjustUnreadCountCache(
          queryClient,
          assistantId,
          -context.unreadCountDelta,
        );
        if (context.unreadRow) {
          adjustSectionUnreadCache(
            queryClient,
            assistantId,
            context.unreadRow,
            -context.unreadCountDelta,
          );
        }
      }
      captureError(err, { context: "markConversationRead" });
    },
    onSettled: (_data, _err, { assistantId }) => {
      void invalidateConversationQueries(queryClient, assistantId);
    },
  });
}
