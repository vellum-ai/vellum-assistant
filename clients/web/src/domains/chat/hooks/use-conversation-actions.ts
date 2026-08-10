import { type MutableRefObject, useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  cancelConversationQueries,
  findConversation,
  invalidateConversationQueries,
  patchConversation,
  restoreConversationCaches,
  snapshotConversationCaches,
  type ConversationCacheSnapshot,
} from "@/utils/conversation-cache";
import { adjustUnreadCountCache } from "@/utils/conversation-cache-mutations";
import { sectionListPrefix } from "@/utils/conversation-list-fetchers";
import { contributesToUnreadCount } from "@/utils/conversation-predicates";
import { executeBulkWithFallback } from "@/utils/bulk-with-fallback";
import {
  conversationsArchiveBulkPost,
  conversationsByIdArchivePost,
  conversationsByIdUnarchivePost,
  conversationsReorderPost,
  conversationsSeenBulkPost,
  conversationsSeenPost,
  conversationsUnreadPost,
} from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { haptic } from "@/utils/haptics";

import type { Conversation } from "@/types/conversation-types";
import { useRenameRequestStore } from "@/domains/chat/rename-request-store";
import {
  findNextConversationId,
  resolveUnpinGroupId,
} from "@/domains/chat/hooks/conversation-action-utils";
import { useMarkConversationSeenMutation } from "@/domains/chat/hooks/use-mark-conversation-seen-mutation";

// ---------------------------------------------------------------------------
// Mutation variable types
// ---------------------------------------------------------------------------

type ArchiveVars = {
  assistantId: string;
  conversationId: string;
  previousArchivedAt: number | undefined;
};
type UnarchiveVars = ArchiveVars;
type MarkUnreadVars = { assistantId: string; conversationId: string };
type MoveToGroupVars = {
  assistantId: string;
  conversationId: string;
  groupId: string;
  isPinned: boolean;
  previousIsPinned: boolean;
  previousGroupId: string | undefined;
};

type MutationContext = { snapshot: ConversationCacheSnapshot };

/**
 * Context for a move between sections. No snapshot: it rolls back by writing
 * the previous field values, which re-derives membership through the same
 * path the optimistic write used.
 *
 * `sectionKeys` is what the optimistic write actually moved, so the settle
 * refetches those sections instead of the whole conversation-list prefix.
 */
type PlacementContext = { sectionKeys: readonly (readonly unknown[])[] };

/**
 * Context for the mark-unread mutation, which additionally applies an
 * optimistic delta to the server-side unread-count cache. `onError` reverts
 * by applying the inverse delta (never a snapshot restore, so a concurrent
 * mutation's adjustment is not clobbered); `onSettled`'s
 * `invalidateConversationQueries` refetches the authoritative count.
 *
 * The mark-seen counterpart lives in `useMarkConversationSeenMutation`,
 * which two entry points share.
 */
type MarkUnreadContext = MutationContext & { unreadCountDelta: number };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Reconcile the sections an optimistic placement moved a row between.
 *
 * Scoped to those sections rather than the conversation-list prefix. The
 * prefix reaches every mounted section *and* the foreground list, and each of
 * those refetches by draining its pages serially, so invalidating it made a
 * pin cost a full re-read of the sidebar. Nothing else about the row changed:
 * a move rewrites `groupId` / `isPinned` and the optimistic write already put
 * the row where those values say it goes.
 *
 * Falls back to the whole section prefix when the write moved nothing, which
 * is the case where the client's idea of the sections is least trustworthy.
 *
 * Returned, not fired and forgotten, so the mutation stays pending until the
 * refetch finishes. TanStack is explicit about this, and it is what makes
 * `isPending` mean "this action is still settling" for anything watching.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates}
 */
function reconcilePlacement(
  queryClient: QueryClient,
  assistantId: string,
  sectionKeys: readonly (readonly unknown[])[] | undefined,
): Promise<unknown> {
  if (!sectionKeys?.length) {
    return queryClient.invalidateQueries({
      queryKey: sectionListPrefix(assistantId),
    });
  }
  return Promise.all(
    sectionKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

/**
 * Conversation CRUD actions: archive, unarchive, rename, mark read/unread,
 * pin/unpin, and move between groups.
 *
 * Single-item mutations use `useMutation` with the TanStack-recommended
 * optimistic update lifecycle (`onMutate` → `onError` → `onSettled`):
 *   1. Cancel outgoing refetches
 *   2. Apply the optimistic update
 *   3. On error: put the changed fields back
 *   4. On settle: invalidate so TanStack refetches
 *
 * **Rollback is by field, never by snapshot, for anything that can run
 * concurrently.** Restoring a whole-cache snapshot taken before mutation A
 * also discards mutation B's successful optimistic write, and pinning two
 * conversations in quick succession is exactly that case. Writing the previous
 * field values back leaves every other row alone, and because section
 * membership is derived from those fields inside `patchConversation`, undoing
 * the fields undoes the move for free.
 *
 * Batch mutations (archive-all, mark-all-read) follow the same lifecycle
 * manually with per-item rollback.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
 * - https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query
 *
 * @returns Stable callbacks for each conversation action.
 */
interface UseConversationActionsParams {
  assistantId: string | null;
  activeConversationId: string | null;
  conversations: Conversation[];
  switchConversation: (key: string) => void;
  startNewConversation: (opts?: { silent?: boolean }) => void;
  prePinGroupIdsRef: MutableRefObject<Map<string, string | undefined>>;
}

export function useConversationActions({
  assistantId,
  activeConversationId,
  conversations,
  switchConversation,
  startNewConversation,
  prePinGroupIdsRef,
}: UseConversationActionsParams) {
  const queryClient = useQueryClient();

  // -------------------------------------------------------------------------
  // Mutations. TanStack-recommended onMutate / onError / onSettled lifecycle:
  //
  //   onMutate  -> cancelQueries, then the optimistic setQueryData
  //   onError   -> put back what this mutation changed, captureError
  //   onSettled -> invalidateQueries (refetch from server)
  //
  // "Put back what this mutation changed" is the field patch for a placement
  // and the inverse delta for the unread count. Only mark-unread still keeps a
  // whole-cache snapshot, because its optimistic write spans a cache the field
  // patch cannot reach.
  // -------------------------------------------------------------------------

  const archiveMutation = useMutation<void, Error, ArchiveVars>({
    mutationFn: async ({ assistantId: aid, conversationId }) => {
      await conversationsByIdArchivePost({
        path: { assistant_id: aid, id: conversationId },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, conversationId }) => {
      await cancelConversationQueries(queryClient, aid);
      patchConversation(queryClient, aid, conversationId, {
        archivedAt: Date.now(),
      });
    },
    onError: (
      err,
      { assistantId: aid, conversationId, previousArchivedAt },
    ) => {
      patchConversation(queryClient, aid, conversationId, {
        archivedAt: previousArchivedAt,
      });
      captureError(err, { context: "archiveConversation" });
    },
    /* Still the full prefix, unlike a move: archiving takes the row out of the
       foreground list and puts it in the archived one, so two caches outside
       the sections change owners and the client does not write either. */
    onSettled: (_data, _err, { assistantId: aid }) =>
      invalidateConversationQueries(queryClient, aid),
  });

  const unarchiveMutation = useMutation<void, Error, UnarchiveVars>({
    mutationFn: async ({ assistantId: aid, conversationId }) => {
      await conversationsByIdUnarchivePost({
        path: { assistant_id: aid, id: conversationId },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, conversationId }) => {
      await cancelConversationQueries(queryClient, aid);
      patchConversation(queryClient, aid, conversationId, {
        archivedAt: undefined,
      });
    },
    onError: (
      err,
      { assistantId: aid, conversationId, previousArchivedAt },
    ) => {
      patchConversation(queryClient, aid, conversationId, {
        archivedAt: previousArchivedAt,
      });
      captureError(err, { context: "unarchiveConversation" });
    },
    onSettled: (_data, _err, { assistantId: aid }) =>
      invalidateConversationQueries(queryClient, aid),
  });

  // Shared with the mark-seen-on-open effect so both entry points produce
  // identical cache effects.
  const markReadMutation = useMarkConversationSeenMutation();

  const markUnreadMutation = useMutation<
    void,
    Error,
    MarkUnreadVars,
    MarkUnreadContext
  >({
    mutationFn: async ({ assistantId: aid, conversationId }) => {
      await conversationsUnreadPost({
        path: { assistant_id: aid },
        body: { conversationId },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, conversationId }) => {
      await cancelConversationQueries(queryClient, aid);
      const snapshot = snapshotConversationCaches(queryClient, aid);
      // Increment the unread count only when flipping this row to unseen
      // makes it start contributing: it must be eligible for the badge
      // (foreground, unarchived) and not already counted as unseen.
      const row = findConversation(queryClient, aid, conversationId);
      const startsContributing =
        row !== undefined &&
        !row.hasUnseenLatestAssistantMessage &&
        contributesToUnreadCount({
          ...row,
          hasUnseenLatestAssistantMessage: true,
        });
      const unreadCountDelta = startsContributing ? 1 : 0;
      if (unreadCountDelta !== 0) {
        adjustUnreadCountCache(queryClient, aid, unreadCountDelta);
      }
      patchConversation(queryClient, aid, conversationId, {
        hasUnseenLatestAssistantMessage: true,
      });
      return { snapshot, unreadCountDelta };
    },
    onError: (err, { assistantId: aid }, context) => {
      if (context?.snapshot) {
        restoreConversationCaches(queryClient, context.snapshot);
      }
      if (context && context.unreadCountDelta !== 0) {
        adjustUnreadCountCache(queryClient, aid, -context.unreadCountDelta);
      }
      captureError(err, { context: "markConversationUnread" });
    },
    onSettled: (_data, _err, { assistantId: aid }) => {
      void invalidateConversationQueries(queryClient, aid);
    },
  });

  const moveToGroupMutation = useMutation<
    void,
    Error,
    MoveToGroupVars,
    PlacementContext
  >({
    mutationFn: async ({
      assistantId: aid,
      conversationId,
      groupId,
      isPinned,
    }) => {
      await conversationsReorderPost({
        path: { assistant_id: aid },
        body: {
          updates: [{ conversationId, isPinned, groupId }],
        },
        throwOnError: true,
      });
    },
    onMutate: async ({
      assistantId: aid,
      conversationId,
      groupId,
      isPinned,
    }) => {
      await cancelConversationQueries(queryClient, aid);
      const sectionKeys = patchConversation(queryClient, aid, conversationId, {
        isPinned,
        groupId,
      });
      return { sectionKeys };
    },
    onSuccess: (_data, { conversationId, isPinned }) => {
      if (!isPinned) {
        prePinGroupIdsRef.current.delete(conversationId);
      }
    },
    onError: (
      err,
      {
        assistantId: aid,
        conversationId,
        isPinned,
        previousIsPinned,
        previousGroupId,
      },
    ) => {
      patchConversation(queryClient, aid, conversationId, {
        isPinned: previousIsPinned,
        groupId: previousGroupId,
      });
      if (isPinned) {
        prePinGroupIdsRef.current.delete(conversationId);
      }
      captureError(err, { context: "moveToGroup" });
    },
    onSettled: (_data, _err, { assistantId: aid }, context) =>
      reconcilePlacement(queryClient, aid, context?.sectionKeys),
  });

  // -------------------------------------------------------------------------
  // Handlers — thin wrappers that compute UI side effects, then fire mutate
  // -------------------------------------------------------------------------

  const handleArchiveConversation = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) {
        return;
      }
      haptic.medium();

      const wasActive = conversation.conversationId === activeConversationId;
      if (wasActive) {
        const nextKey = findNextConversationId(
          conversations,
          conversation.conversationId,
        );
        if (nextKey) {
          switchConversation(nextKey);
        } else {
          startNewConversation({ silent: true });
        }
      }

      archiveMutation.mutate({
        assistantId,
        conversationId: conversation.conversationId,
        previousArchivedAt: conversation.archivedAt,
      });
    },
    [
      activeConversationId,
      assistantId,
      conversations,
      switchConversation,
      startNewConversation,
      archiveMutation,
    ],
  );

  const handleUnarchiveConversation = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) {
        return;
      }
      unarchiveMutation.mutate({
        assistantId,
        conversationId: conversation.conversationId,
        previousArchivedAt: conversation.archivedAt,
      });
    },
    [assistantId, unarchiveMutation],
  );

  const handleMarkConversationUnread = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) {
        return;
      }
      if (
        conversation.hasUnseenLatestAssistantMessage ||
        !conversation.latestAssistantMessageAt
      ) {
        return;
      }
      markUnreadMutation.mutate({
        assistantId,
        conversationId: conversation.conversationId,
      });
    },
    [assistantId, markUnreadMutation],
  );

  const handleMarkConversationRead = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) {
        return;
      }
      if (!conversation.hasUnseenLatestAssistantMessage) {
        return;
      }
      markReadMutation.mutate({
        assistantId,
        conversationId: conversation.conversationId,
      });
    },
    [assistantId, markReadMutation],
  );

  const handleMoveToGroup = useCallback(
    (conversation: Conversation, groupId: string) => {
      if (!assistantId) {
        return;
      }
      haptic.light();

      const previousIsPinned = conversation.isPinned ?? false;
      const previousGroupId = conversation.groupId;
      const isPinned = groupId === "system:pinned";

      if (isPinned) {
        prePinGroupIdsRef.current.set(
          conversation.conversationId,
          conversation.groupId,
        );
      }

      moveToGroupMutation.mutate({
        assistantId,
        conversationId: conversation.conversationId,
        groupId,
        isPinned,
        previousIsPinned,
        previousGroupId,
      });
    },
    [assistantId, prePinGroupIdsRef, moveToGroupMutation],
  );

  /**
   * Remove a conversation from its current custom group, returning it to
   * Recents (`"system:all"`). Reuses the move-to-group optimistic path.
   */
  const handleRemoveFromGroup = useCallback(
    (conversation: Conversation) => {
      handleMoveToGroup(conversation, "system:all");
    },
    [handleMoveToGroup],
  );

  const handleTogglePinConversation = useCallback(
    (conversation: Conversation) => {
      const currentlyPinned =
        conversation.isPinned || conversation.groupId === "system:pinned";
      const targetGroupId = currentlyPinned
        ? resolveUnpinGroupId(conversation, prePinGroupIdsRef.current)
        : "system:pinned";
      handleMoveToGroup(conversation, targetGroupId);
    },
    [handleMoveToGroup, prePinGroupIdsRef],
  );

  const handleRenameConversation = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) {
        return;
      }
      useRenameRequestStore
        .getState()
        .requestRename(conversation.conversationId, conversation.title ?? "");
    },
    [assistantId],
  );

  // -------------------------------------------------------------------------
  // Batch operations — same lifecycle (cancel → snapshot → optimistic → API
  // → rollback on error → invalidate) applied per item in the batch.
  // -------------------------------------------------------------------------

  const handleMarkAllReadInGroup = useCallback(
    async (groupConversations: Conversation[]) => {
      if (!assistantId) {
        return;
      }
      const unread = groupConversations.filter(
        (c) => c.hasUnseenLatestAssistantMessage,
      );
      if (unread.length === 0) {
        return;
      }

      await cancelConversationQueries(queryClient, assistantId);

      // One optimistic decrement for the rows that count toward the unread
      // badge (foreground, unarchived); rows that fail roll their share
      // back one at a time in `rollbackItem`.
      const contributingCount = unread.filter(contributesToUnreadCount).length;
      if (contributingCount > 0) {
        adjustUnreadCountCache(queryClient, assistantId, -contributingCount);
      }

      for (const c of unread) {
        patchConversation(queryClient, assistantId, c.conversationId, {
          hasUnseenLatestAssistantMessage: false,
        });
      }

      await executeBulkWithFallback({
        items: unread,
        bulkCall: () =>
          conversationsSeenBulkPost({
            path: { assistant_id: assistantId },
            body: { conversationIds: unread.map((c) => c.conversationId) },
          }),
        fallbackFn: (c) =>
          conversationsSeenPost({
            path: { assistant_id: assistantId },
            body: { conversationId: c.conversationId },
            throwOnError: true,
          }),
        rollbackItem: (c) => {
          patchConversation(queryClient, assistantId, c.conversationId, {
            hasUnseenLatestAssistantMessage: true,
          });
          if (contributesToUnreadCount(c)) {
            adjustUnreadCountCache(queryClient, assistantId, 1);
          }
        },
        context: "markAllReadInGroup",
      });

      void invalidateConversationQueries(queryClient, assistantId);
    },
    [assistantId, queryClient],
  );

  const handleArchiveAllInGroup = useCallback(
    async (_groupName: string, groupConversations: Conversation[]) => {
      if (!assistantId) {
        return;
      }
      if (groupConversations.length === 0) {
        return;
      }

      await cancelConversationQueries(queryClient, assistantId);

      const activeId = activeConversationId;
      const archivingActive = groupConversations.some(
        (c) => c.conversationId === activeId,
      );

      for (const c of groupConversations) {
        patchConversation(queryClient, assistantId, c.conversationId, {
          archivedAt: Date.now(),
        });
      }

      if (archivingActive) {
        const nonGroupIds = new Set(
          groupConversations.map((c) => c.conversationId),
        );
        const nextKey = findNextConversationId(
          conversations.filter((c) => !nonGroupIds.has(c.conversationId)),
          activeId!,
        );
        if (nextKey) {
          switchConversation(nextKey);
        } else {
          startNewConversation({ silent: true });
        }
      }

      await executeBulkWithFallback({
        items: groupConversations,
        bulkCall: () =>
          conversationsArchiveBulkPost({
            path: { assistant_id: assistantId },
            body: {
              conversationIds: groupConversations.map((c) => c.conversationId),
            },
          }),
        fallbackFn: (c) =>
          conversationsByIdArchivePost({
            path: { assistant_id: assistantId, id: c.conversationId },
            throwOnError: true,
          }),
        rollbackItem: (c) =>
          patchConversation(queryClient, assistantId, c.conversationId, {
            archivedAt: c.archivedAt,
          }),
        context: "archiveAllInGroup",
      });

      void invalidateConversationQueries(queryClient, assistantId);
    },
    [
      activeConversationId,
      assistantId,
      conversations,
      queryClient,
      startNewConversation,
      switchConversation,
    ],
  );

  return {
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    handleTogglePinConversation,
    handleMoveToGroup,
    handleRemoveFromGroup,
    handleRenameConversation,
    handleMarkAllReadInGroup,
    handleArchiveAllInGroup,
  };
}
