
import * as Sentry from "@sentry/react";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  appendGroup,
  chatContextQueryKey,
  conversationGroupsQueryKey,
  deleteGroupAndResetConversations,
  patchGroup,
  removeGroup,
  replaceOptimisticGroup,
} from "@/domains/conversations/conversation-queries";

import { haptic } from "@/utils/haptics";
import { type ConversationGroup, createGroup, deleteGroup, updateGroup } from "@/domains/chat/api/conversations";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Folder/group CRUD actions: create, rename, and delete conversation groups.
 *
 * Each action applies an optimistic update against the TanStack Query
 * groups cache before hitting the API. On failure, create/rename roll back
 * optimistically; delete invalidates both the chat-context and groups
 * caches so subscribers refetch for accuracy.
 *
 * @returns Stable callbacks: `handleCreateGroup`, `handleRenameGroup`,
 *   `handleDeleteGroup`.
 */
interface UseConversationGroupActionsParams {
  assistantId: string | null;
  conversationGroups: ConversationGroup[];
}

export function useConversationGroupActions({
  assistantId,
  conversationGroups,
}: UseConversationGroupActionsParams) {
  const queryClient = useQueryClient();

  const handleCreateGroup = useCallback(async () => {
    if (!assistantId) return;
    haptic.light();
    const name =
      typeof window === "undefined"
        ? null
        : window.prompt("New group name");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    const optimisticId = `optimistic-${Date.now()}`;
    appendGroup(queryClient, assistantId, { id: optimisticId, name: trimmed, sortPosition: 0, isSystemGroup: false });

    try {
      const created = await createGroup(assistantId, trimmed);
      replaceOptimisticGroup(queryClient, assistantId, optimisticId, created);
    } catch (err) {
      removeGroup(queryClient, assistantId, optimisticId);
      Sentry.captureException(err, {
        tags: { context: "createGroup" },
      });
    }
  }, [assistantId, queryClient]);

  const handleRenameGroup = useCallback(
    async (groupId: string) => {
      if (!assistantId) return;
      const current = conversationGroups.find((g) => g.id === groupId)?.name ?? "";
      const next =
        typeof window === "undefined"
          ? null
          : window.prompt("Rename group", current);
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === current) return;

      patchGroup(queryClient, assistantId, groupId, { name: trimmed });

      try {
        await updateGroup(assistantId, groupId, { name: trimmed });
      } catch (err) {
        patchGroup(queryClient, assistantId, groupId, { name: current });
        Sentry.captureException(err, {
          tags: { context: "renameGroup" },
        });
      }
    },
    [assistantId, conversationGroups, queryClient],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (!assistantId) return;
      haptic.medium();

      deleteGroupAndResetConversations(queryClient, assistantId, groupId);

      try {
        await deleteGroup(assistantId, groupId);
      } catch (err) {
        // Rollback is imprecise — we can't distinguish conversations that
        // already had no groupId from those we just cleared — so invalidate
        // both caches and let subscribers refetch for accuracy.
        void queryClient.invalidateQueries({
          queryKey: chatContextQueryKey(assistantId),
        });
        void queryClient.invalidateQueries({
          queryKey: conversationGroupsQueryKey(assistantId),
        });
        Sentry.captureException(err, {
          tags: { context: "deleteGroup" },
        });
      }
    },
    [assistantId, queryClient],
  );

  return {
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
  };
}
