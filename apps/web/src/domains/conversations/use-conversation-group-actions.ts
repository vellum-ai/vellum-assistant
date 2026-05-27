
import * as Sentry from "@sentry/react";
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  groupsByGroupIdDeleteMutation,
  groupsByGroupIdPatchMutation,
  groupsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  GroupsByGroupIdDeleteData,
  GroupsByGroupIdPatchData,
  GroupsPostData,
} from "@/generated/daemon/types.gen";

import {
  appendGroup,
  conversationGroupsQueryKey,
  chatContextQueryKey,
  deleteGroupAndResetConversations,
  patchGroup,
  removeGroup,
  replaceOptimisticGroup,
} from "@/domains/conversations/conversation-queries";

import { haptic } from "@/utils/haptics";
import type { ConversationGroup } from "@/lib/conversations-api";

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

  const { mutateAsync: createGroupAsync } = useMutation({
    ...groupsPostMutation(),
    onError: (err) => {
      Sentry.captureException(err, {
        tags: { context: "createGroup" },
      });
    },
  });

  const { mutateAsync: patchGroupAsync } = useMutation({
    ...groupsByGroupIdPatchMutation(),
    onError: (err) => {
      Sentry.captureException(err, {
        tags: { context: "renameGroup" },
      });
    },
  });

  const { mutateAsync: deleteGroupAsync } = useMutation({
    ...groupsByGroupIdDeleteMutation(),
    onError: (err) => {
      Sentry.captureException(err, {
        tags: { context: "deleteGroup" },
      });
    },
  });

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
      const created = await createGroupAsync({
        path: { assistant_id: assistantId },
        body: { name: trimmed },
      } as Options<GroupsPostData>);
      replaceOptimisticGroup(queryClient, assistantId, optimisticId, created);
    } catch {
      removeGroup(queryClient, assistantId, optimisticId);
    }
  }, [assistantId, queryClient, createGroupAsync]);

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
        await patchGroupAsync({
          path: { assistant_id: assistantId, groupId },
          body: { name: trimmed },
        } as Options<GroupsByGroupIdPatchData>);
      } catch {
        patchGroup(queryClient, assistantId, groupId, { name: current });
      }
    },
    [assistantId, conversationGroups, queryClient, patchGroupAsync],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (!assistantId) return;
      haptic.medium();

      deleteGroupAndResetConversations(queryClient, assistantId, groupId);

      try {
        await deleteGroupAsync({
          path: { assistant_id: assistantId, groupId },
        } as Options<GroupsByGroupIdDeleteData>);
      } catch {
        void queryClient.invalidateQueries({
          queryKey: chatContextQueryKey(assistantId),
        });
        void queryClient.invalidateQueries({
          queryKey: conversationGroupsQueryKey(assistantId),
        });
      }
    },
    [assistantId, queryClient, deleteGroupAsync],
  );

  return {
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
  };
}
