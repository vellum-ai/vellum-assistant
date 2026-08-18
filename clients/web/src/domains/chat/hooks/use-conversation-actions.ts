import { type MutableRefObject, useCallback, useRef } from "react";
import {
  hashKey,
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
import {
  adjustSectionUnreadCache,
  adjustUnreadCountCache,
} from "@/utils/conversation-cache-mutations";
import { sidebarSectionsQueryKey } from "@/utils/conversation-list-fetchers";
import {
  conversationListQueryFilter,
  isSectionFilter,
} from "@/utils/conversation-list-keys";
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
  resolvePlacementSurfacedAt,
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
  /**
   * The promotion marker the placement leaves behind. Carried as a variable
   * rather than derived in `onMutate` so the optimistic write and its rollback
   * read the same value, and so the timestamp is stamped once instead of
   * being re-taken on a retry.
   */
  surfacedAt: number | undefined;
  previousIsPinned: boolean;
  previousGroupId: string | undefined;
  previousSurfacedAt: number | undefined;
};

type MutationContext = { snapshot: ConversationCacheSnapshot };

/**
 * Context for a move between sections. No snapshot: it rolls back by writing
 * the previous field values, which re-derives membership through the same
 * path the optimistic write used.
 *
 * `token` identifies this mutation's optimistic write among the writes to the
 * same conversation, and both the rollback and the settle refetch are gated on
 * it still being the current one. Two moves of one conversation overlap
 * whenever the second starts before the first settles, and either action taken
 * by the older move lands on top of the newer placement: a rollback restores
 * what preceded the older move, and a refetch brings back server state the
 * newer move has not reached yet.
 *
 * The section keys live in the hook's placement record rather than here,
 * because the move that ends up reconciling has to refetch what its
 * predecessors touched as well as its own.
 */
type PlacementContext = { token: number };

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
type MarkUnreadContext = MutationContext & {
  unreadCountDelta: number;
  /** The row the deltas hit, for bucket-exact reversal; see MarkSeenContext. */
  unreadRow?: Conversation;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Refetch the sections an optimistic placement could not settle on its own.
 *
 * Scoped to those sections rather than the conversation-list prefix. The
 * prefix reaches every mounted section *and* the foreground list, each of
 * which refetches by draining its pages serially, so invalidating it costs a
 * full re-read of the sidebar to learn one row's group. A move rewrites
 * `groupId` / `isPinned` / `surfacedAt` and nothing else, and the optimistic
 * write has already put the row where those values say it goes.
 *
 * Falls back to the whole section prefix when the write reports nothing, the
 * case where the client's idea of the sections is least trustworthy.
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
  /* The section index rides every placement settle: a move can create or
     empty a section and always shifts its counts, and the daemon suppresses
     sync echo to the originating client, so this settle is the only local
     refresh the index gets. */
  const refreshIndex = queryClient.invalidateQueries({
    queryKey: sidebarSectionsQueryKey(assistantId),
  });
  if (!sectionKeys?.length) {
    return Promise.all([
      refreshIndex,
      queryClient.invalidateQueries(
        conversationListQueryFilter(assistantId, isSectionFilter),
      ),
    ]);
  }
  /* Exact: a section key used as a partial filter would also match every
     section whose filter extends it (Chats matches each channel card), and
     that would refetch caches the move never touched. */
  return Promise.all([
    refreshIndex,
    ...sectionKeys.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, exact: true }),
    ),
  ]);
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
 * That covers overlapping moves of *different* conversations. Overlapping
 * moves of the *same* conversation need one thing more, because both write the
 * same fields: a failing move rolls back only while its own write is still the
 * one showing (`PlacementContext.token`). Otherwise the user's newer placement
 * would be replaced by whatever preceded the older, failed one.
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

  /* The latest optimistic placement of each conversation, so a move that
     settles can tell whether its own write is still the one showing. A ref
     rather than a store: nothing renders from it, and it is read and written
     inside the mutation lifecycle.

     Tokens come from one counter that only ever increases, and never from the
     map's current value. Deriving the next token from the entry would let a
     conversation whose entry was cleaned up reissue a token an older in-flight
     move still holds, and that move's ownership check would then pass against
     someone else's write.

     Each entry also carries the section keys of every placement folded into
     it, so the move that ends up owning the reconciliation refetches the
     sections its predecessors touched as well as its own. */
  const placementTokenRef = useRef(0);
  const placementsRef = useRef(
    new Map<
      string,
      { token: number; sectionKeys: Map<string, readonly unknown[]> }
    >(),
  );

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
      const unreadRow = startsContributing ? row : undefined;
      const unreadCountDelta = unreadRow ? 1 : 0;
      if (unreadRow) {
        adjustUnreadCountCache(queryClient, aid, unreadCountDelta);
        adjustSectionUnreadCache(queryClient, aid, unreadRow, unreadCountDelta);
      }
      patchConversation(queryClient, aid, conversationId, {
        hasUnseenLatestAssistantMessage: true,
      });
      return { snapshot, unreadCountDelta, unreadRow };
    },
    onError: (err, { assistantId: aid }, context) => {
      if (context?.snapshot) {
        restoreConversationCaches(queryClient, context.snapshot);
      }
      if (context && context.unreadCountDelta !== 0) {
        adjustUnreadCountCache(queryClient, aid, -context.unreadCountDelta);
        if (context.unreadRow) {
          adjustSectionUnreadCache(
            queryClient,
            aid,
            context.unreadRow,
            -context.unreadCountDelta,
          );
        }
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
      surfacedAt,
    }) => {
      await cancelConversationQueries(queryClient, aid);
      /* Claimed immediately before the write, not when `mutate` was called:
         `onMutate` awaits, so two overlapping moves resume in whatever order
         their cancellations settle, and the token has to order the writes as
         they actually land. */
      const token = ++placementTokenRef.current;
      const sectionKeys = patchConversation(queryClient, aid, conversationId, {
        isPinned,
        groupId,
        surfacedAt,
      });
      const inherited =
        placementsRef.current.get(conversationId)?.sectionKeys ??
        new Map<string, readonly unknown[]>();
      for (const queryKey of sectionKeys) {
        inherited.set(hashKey(queryKey), queryKey);
      }
      placementsRef.current.set(conversationId, {
        token,
        sectionKeys: inherited,
      });
      return { token };
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
        previousSurfacedAt,
      },
      context,
    ) => {
      /* Only the latest write may undo itself. A move superseded by another
         move of the same conversation leaves the newer placement alone: the
         user has already moved the row somewhere else, and restoring what came
         before this failure would put it back in a section they left. The
         newer mutation owns the correction from here, and its settle refetch
         is the backstop if it fails too. */
      if (placementsRef.current.get(conversationId)?.token === context?.token) {
        patchConversation(queryClient, aid, conversationId, {
          isPinned: previousIsPinned,
          groupId: previousGroupId,
          surfacedAt: previousSurfacedAt,
        });
      }
      if (isPinned) {
        prePinGroupIdsRef.current.delete(conversationId);
      }
      captureError(err, { context: "moveToGroup" });
    },
    /* Refetching is the latest placement's job too, for the same reason the
       rollback is. A superseded move that invalidated its own sections would
       refetch state the server has not applied the newer move to yet, and that
       response would land on top of the newer optimistic write: the cancel
       that protects an optimistic write runs when that write is made, so it
       cannot reach a refetch an older move starts afterwards. The owner
       refetches the accumulated sections, so nothing a superseded move touched
       goes unreconciled. */
    onSettled: (_data, _err, { assistantId: aid, conversationId }, context) => {
      if (!context) {
        /* `onMutate` did not finish, so there is no optimistic write to own
           and nothing accumulated to refetch. The request may still have
           reached the server, so reconcile broadly rather than not at all. */
        return reconcilePlacement(queryClient, aid, undefined);
      }
      const placement = placementsRef.current.get(conversationId);
      if (placement?.token !== context.token) {
        /* Superseded, or the owner has already settled and reconciled. */
        return;
      }
      placementsRef.current.delete(conversationId);
      return reconcilePlacement(queryClient, aid, [
        ...placement.sectionKeys.values(),
      ]);
    },
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
      const previousSurfacedAt = conversation.surfacedAt;
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
        surfacedAt: resolvePlacementSurfacedAt(
          conversation,
          groupId,
          Date.now(),
        ),
        previousIsPinned,
        previousGroupId,
        previousSurfacedAt,
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
      const contributing = unread.filter(contributesToUnreadCount);
      if (contributing.length > 0) {
        adjustUnreadCountCache(queryClient, assistantId, -contributing.length);
        for (const c of contributing) {
          adjustSectionUnreadCache(queryClient, assistantId, c, -1);
        }
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
            adjustSectionUnreadCache(queryClient, assistantId, c, 1);
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
