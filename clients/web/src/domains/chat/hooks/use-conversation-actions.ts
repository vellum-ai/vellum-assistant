
import { type MutableRefObject, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  cancelConversationQueries,
  invalidateConversationQueries,
  patchConversation,
  restoreConversationCaches,
  snapshotConversationCaches,
  updateAllConversationCaches,
  type ConversationCacheSnapshot,
} from "@/utils/conversation-cache";
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

// ---------------------------------------------------------------------------
// Mutation variable types
// ---------------------------------------------------------------------------

type ArchiveVars = { assistantId: string; conversationId: string };
type UnarchiveVars = { assistantId: string; conversationId: string };
type MarkReadVars = { assistantId: string; conversationId: string };
type MarkUnreadVars = { assistantId: string; conversationId: string };
type MoveToGroupVars = {
  assistantId: string;
  conversationId: string;
  groupId: string;
  isPinned: boolean;
  previousIsPinned: boolean;
  previousGroupId: string | undefined;
};
type ReorderVars = { assistantId: string; orderedIds: string[] };

type MutationContext = { snapshot: ConversationCacheSnapshot };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Conversation CRUD actions: archive, unarchive, rename, mark read/unread,
 * pin/unpin, and move between groups.
 *
 * Single-item mutations use `useMutation` with the TanStack-recommended
 * optimistic update lifecycle (`onMutate` → `onError` → `onSettled`):
 *   1. Cancel outgoing refetches
 *   2. Snapshot the cache
 *   3. Apply the optimistic update
 *   4. On error: restore the snapshot
 *   5. On settle: invalidate so TanStack refetches
 *
 * Batch mutations (archive-all, mark-all-read) follow the same lifecycle
 * manually with per-item rollback.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
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
  // Mutations — TanStack-recommended onMutate / onError / onSettled lifecycle
  //
  // Each mutation:
  //   onMutate  → cancelQueries, snapshot, optimistic setQueryData
  //   onError   → restore snapshot, captureError
  //   onSettled → invalidateQueries (refetch from server)
  // -------------------------------------------------------------------------

  const archiveMutation = useMutation<void, Error, ArchiveVars, MutationContext>({
    mutationFn: async ({ assistantId: aid, conversationId }) => {
      await conversationsByIdArchivePost({
        path: { assistant_id: aid, id: conversationId },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, conversationId }) => {
      await cancelConversationQueries(queryClient, aid);
      const snapshot = snapshotConversationCaches(queryClient, aid);
      patchConversation(queryClient, aid, conversationId, { archivedAt: Date.now() });
      return { snapshot };
    },
    onError: (err, _vars, context) => {
      if (context?.snapshot) restoreConversationCaches(queryClient, context.snapshot);
      captureError(err, { context: "archiveConversation" });
    },
    onSettled: (_data, _err, { assistantId: aid }) => {
      void invalidateConversationQueries(queryClient, aid);
    },
  });

  const unarchiveMutation = useMutation<void, Error, UnarchiveVars, MutationContext>({
    mutationFn: async ({ assistantId: aid, conversationId }) => {
      await conversationsByIdUnarchivePost({
        path: { assistant_id: aid, id: conversationId },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, conversationId }) => {
      await cancelConversationQueries(queryClient, aid);
      const snapshot = snapshotConversationCaches(queryClient, aid);
      patchConversation(queryClient, aid, conversationId, { archivedAt: undefined });
      return { snapshot };
    },
    onError: (err, _vars, context) => {
      if (context?.snapshot) restoreConversationCaches(queryClient, context.snapshot);
      captureError(err, { context: "unarchiveConversation" });
    },
    onSettled: (_data, _err, { assistantId: aid }) => {
      void invalidateConversationQueries(queryClient, aid);
    },
  });

  const markReadMutation = useMutation<void, Error, MarkReadVars, MutationContext>({
    mutationFn: async ({ assistantId: aid, conversationId }) => {
      await conversationsSeenPost({
        path: { assistant_id: aid },
        body: { conversationId },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, conversationId }) => {
      await cancelConversationQueries(queryClient, aid);
      const snapshot = snapshotConversationCaches(queryClient, aid);
      patchConversation(queryClient, aid, conversationId, { hasUnseenLatestAssistantMessage: false });
      return { snapshot };
    },
    onError: (err, _vars, context) => {
      if (context?.snapshot) restoreConversationCaches(queryClient, context.snapshot);
      captureError(err, { context: "markConversationRead" });
    },
    onSettled: (_data, _err, { assistantId: aid }) => {
      void invalidateConversationQueries(queryClient, aid);
    },
  });

  const markUnreadMutation = useMutation<void, Error, MarkUnreadVars, MutationContext>({
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
      patchConversation(queryClient, aid, conversationId, { hasUnseenLatestAssistantMessage: true });
      return { snapshot };
    },
    onError: (err, _vars, context) => {
      if (context?.snapshot) restoreConversationCaches(queryClient, context.snapshot);
      captureError(err, { context: "markConversationUnread" });
    },
    onSettled: (_data, _err, { assistantId: aid }) => {
      void invalidateConversationQueries(queryClient, aid);
    },
  });

  const moveToGroupMutation = useMutation<void, Error, MoveToGroupVars, MutationContext>({
    mutationFn: async ({ assistantId: aid, conversationId, groupId, isPinned }) => {
      await conversationsReorderPost({
        path: { assistant_id: aid },
        body: {
          updates: [{ conversationId, isPinned, groupId }],
        },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, conversationId, groupId, isPinned }) => {
      await cancelConversationQueries(queryClient, aid);
      const snapshot = snapshotConversationCaches(queryClient, aid);
      patchConversation(queryClient, aid, conversationId, { isPinned, groupId });
      return { snapshot };
    },
    onSuccess: (_data, { conversationId, isPinned }) => {
      if (!isPinned) {
        prePinGroupIdsRef.current.delete(conversationId);
      }
    },
    onError: (err, { conversationId, isPinned }, context) => {
      if (context?.snapshot) restoreConversationCaches(queryClient, context.snapshot);
      if (isPinned) {
        prePinGroupIdsRef.current.delete(conversationId);
      }
      captureError(err, { context: "moveToGroup" });
    },
    onSettled: (_data, _err, { assistantId: aid }) => {
      void invalidateConversationQueries(queryClient, aid);
    },
  });

  const reorderMutation = useMutation<void, Error, ReorderVars, MutationContext>({
    mutationFn: async ({ assistantId: aid, orderedIds }) => {
      await conversationsReorderPost({
        path: { assistant_id: aid },
        body: {
          // displayOrder-only updates — the daemon preserves each
          // conversation's pin state and group assignment.
          updates: orderedIds.map((conversationId, index) => ({
            conversationId,
            displayOrder: index,
          })),
        },
        throwOnError: true,
      });
    },
    onMutate: async ({ assistantId: aid, orderedIds }) => {
      await cancelConversationQueries(queryClient, aid);
      const snapshot = snapshotConversationCaches(queryClient, aid);
      const orderById = new Map(orderedIds.map((id, index) => [id, index]));
      updateAllConversationCaches(queryClient, aid, (conversations) =>
        conversations.map((c) => {
          const displayOrder = orderById.get(c.conversationId);
          return displayOrder === undefined ? c : { ...c, displayOrder };
        }),
      );
      return { snapshot };
    },
    onError: (err, _vars, context) => {
      if (context?.snapshot) restoreConversationCaches(queryClient, context.snapshot);
      captureError(err, { context: "reorderConversations" });
    },
    onSettled: (_data, _err, { assistantId: aid }) => {
      void invalidateConversationQueries(queryClient, aid);
    },
  });

  // -------------------------------------------------------------------------
  // Handlers — thin wrappers that compute UI side effects, then fire mutate
  // -------------------------------------------------------------------------

  const handleArchiveConversation = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) return;
      haptic.medium();

      const wasActive = conversation.conversationId === activeConversationId;
      if (wasActive) {
        const nextKey = findNextConversationId(conversations, conversation.conversationId);
        if (nextKey) {
          switchConversation(nextKey);
        } else {
          startNewConversation({ silent: true });
        }
      }

      archiveMutation.mutate({ assistantId, conversationId: conversation.conversationId });
    },
    [activeConversationId, assistantId, conversations, switchConversation, startNewConversation, archiveMutation],
  );

  const handleUnarchiveConversation = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) return;
      unarchiveMutation.mutate({ assistantId, conversationId: conversation.conversationId });
    },
    [assistantId, unarchiveMutation],
  );

  const handleMarkConversationUnread = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) return;
      if (conversation.hasUnseenLatestAssistantMessage || !conversation.latestAssistantMessageAt) return;
      markUnreadMutation.mutate({ assistantId, conversationId: conversation.conversationId });
    },
    [assistantId, markUnreadMutation],
  );

  const handleMarkConversationRead = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) return;
      if (!conversation.hasUnseenLatestAssistantMessage) return;
      markReadMutation.mutate({ assistantId, conversationId: conversation.conversationId });
    },
    [assistantId, markReadMutation],
  );

  const handleMoveToGroup = useCallback(
    (conversation: Conversation, groupId: string) => {
      if (!assistantId) return;
      haptic.light();

      const previousIsPinned = conversation.isPinned ?? false;
      const previousGroupId = conversation.groupId;
      const isPinned = groupId === "system:pinned";

      if (isPinned) {
        prePinGroupIdsRef.current.set(conversation.conversationId, conversation.groupId);
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

  /**
   * Persist a user drag-reorder. `ordered` is a sidebar section's full
   * conversation list (pinned or one custom group) in its new order;
   * each row's `displayOrder` becomes its index.
   */
  const handleReorderConversations = useCallback(
    (ordered: Conversation[]) => {
      if (!assistantId || ordered.length < 2) return;
      haptic.light();
      reorderMutation.mutate({
        assistantId,
        orderedIds: ordered.map((c) => c.conversationId),
      });
    },
    [assistantId, reorderMutation],
  );

  const handleRenameConversation = useCallback(
    (conversation: Conversation) => {
      if (!assistantId) return;
      useRenameRequestStore.getState().requestRename(
        conversation.conversationId,
        conversation.title ?? "",
      );
    },
    [assistantId],
  );

  // -------------------------------------------------------------------------
  // Batch operations — same lifecycle (cancel → snapshot → optimistic → API
  // → rollback on error → invalidate) applied per item in the batch.
  // -------------------------------------------------------------------------

  const handleMarkAllReadInGroup = useCallback(
    async (groupConversations: Conversation[]) => {
      if (!assistantId) return;
      const unread = groupConversations.filter(
        (c) => c.hasUnseenLatestAssistantMessage,
      );
      if (unread.length === 0) return;

      await cancelConversationQueries(queryClient, assistantId);

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
        rollbackItem: (c) =>
          patchConversation(queryClient, assistantId, c.conversationId, {
            hasUnseenLatestAssistantMessage: true,
          }),
        context: "markAllReadInGroup",
      });

      void invalidateConversationQueries(queryClient, assistantId);
    },
    [assistantId, queryClient],
  );

  const handleArchiveAllInGroup = useCallback(
    async (_groupName: string, groupConversations: Conversation[]) => {
      if (!assistantId) return;
      if (groupConversations.length === 0) return;

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
    handleRenameConversation,
    handleReorderConversations,
    handleMarkAllReadInGroup,
    handleArchiveAllInGroup,
  };
}
