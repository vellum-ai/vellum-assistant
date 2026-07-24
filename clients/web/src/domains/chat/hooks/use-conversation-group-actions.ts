
import { captureError } from "@/lib/sentry/capture-error";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useGroupsByGroupIdDeleteMutation,
  useGroupsByGroupIdPatchMutation,
  useGroupsPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  GroupsByGroupIdDeleteData,
  GroupsByGroupIdPatchData,
  GroupsPostData,
} from "@/generated/daemon/types.gen";

import {
  appendGroup,
  deleteGroupAndResetConversations,
  patchGroup,
  removeGroup,
  replaceOptimisticGroup,
} from "@/utils/conversation-cache-mutations";
import { cancelConversationQueries, invalidateConversationQueries } from "@/utils/conversation-cache";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

import { haptic } from "@/utils/haptics";
import type { ConversationGroup } from "@/types/conversation-types";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Folder/group CRUD actions: create, rename, and delete conversation groups.
 *
 * Each action uses the TanStack-recommended optimistic update lifecycle:
 *   onMutate  → cancel queries, snapshot, apply optimistic update
 *   onError   → restore from snapshot
 *   onSettled → invalidate so TanStack refetches from server
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
 *
 * @returns Stable callbacks: `createGroup`, `renameGroup`, `handleDeleteGroup`.
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

  const { mutateAsync: createGroupAsync } = useGroupsPostMutation({
    onError: (err) => {
      captureError(err, { context: "createGroup" });
    },
  });

  const { mutateAsync: patchGroupAsync } = useGroupsByGroupIdPatchMutation({
    onError: (err) => {
      captureError(err, { context: "renameGroup" });
    },
  });

  const { mutateAsync: deleteGroupAsync } = useGroupsByGroupIdDeleteMutation({
    onError: (err) => {
      captureError(err, { context: "deleteGroup" });
    },
  });

  const createGroup = useCallback(
    async (name: string): Promise<ConversationGroup | null> => {
      if (!assistantId) {return null;}
      const trimmed = name.trim();
      if (!trimmed) {return null;}
      haptic.light();

      const groupsKey = groupsGetQueryKey({ path: { assistant_id: assistantId } });
      await queryClient.cancelQueries({ queryKey: groupsKey });

      const optimisticId = `optimistic-${Date.now()}`;
      appendGroup(queryClient, assistantId, { id: optimisticId, name: trimmed, sortPosition: 0, isSystemGroup: false });

      try {
        const created = await createGroupAsync({
          path: { assistant_id: assistantId },
          body: { name: trimmed },
        } as Options<GroupsPostData>);
        replaceOptimisticGroup(queryClient, assistantId, optimisticId, created);
        return created;
      } catch {
        removeGroup(queryClient, assistantId, optimisticId);
        return null;
      } finally {
        void queryClient.invalidateQueries({ queryKey: groupsKey });
      }
    },
    [assistantId, queryClient, createGroupAsync],
  );

  const renameGroup = useCallback(
    async (groupId: string, name: string) => {
      if (!assistantId) {return;}
      const current = conversationGroups.find((g) => g.id === groupId)?.name ?? "";
      const trimmed = name.trim();
      if (!trimmed || trimmed === current) {return;}

      const groupsKey = groupsGetQueryKey({ path: { assistant_id: assistantId } });
      await queryClient.cancelQueries({ queryKey: groupsKey });

      patchGroup(queryClient, assistantId, groupId, { name: trimmed });

      try {
        await patchGroupAsync({
          path: { assistant_id: assistantId, groupId },
          body: { name: trimmed },
        } as Options<GroupsByGroupIdPatchData>);
      } catch {
        patchGroup(queryClient, assistantId, groupId, { name: current });
      } finally {
        void queryClient.invalidateQueries({ queryKey: groupsKey });
      }
    },
    [assistantId, conversationGroups, queryClient, patchGroupAsync],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (!assistantId) return;
      haptic.medium();

      const groupsKey = groupsGetQueryKey({ path: { assistant_id: assistantId } });
      await Promise.all([
        cancelConversationQueries(queryClient, assistantId),
        queryClient.cancelQueries({ queryKey: groupsKey }),
      ]);

      deleteGroupAndResetConversations(queryClient, assistantId, groupId);

      try {
        await deleteGroupAsync({
          path: { assistant_id: assistantId, groupId },
        } as Options<GroupsByGroupIdDeleteData>);
      } catch {
        // Full rollback not possible — the group's prior state is destroyed
        // by `deleteGroupAndResetConversations`. Invalidate both caches so
        // TanStack refetches the server-authoritative state.
      } finally {
        void invalidateConversationQueries(queryClient, assistantId);
        void queryClient.invalidateQueries({ queryKey: groupsKey });
      }
    },
    [assistantId, queryClient, deleteGroupAsync],
  );

  return {
    createGroup,
    renameGroup,
    handleDeleteGroup,
  };
}
