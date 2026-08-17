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
import {
  cancelConversationQueries,
  invalidateConversationQueries,
} from "@/utils/conversation-cache";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { sidebarSectionsQueryKey } from "@/utils/conversation-list-fetchers";

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
    async (
      name: string,
      icon?: string | null,
    ): Promise<ConversationGroup | null> => {
      if (!assistantId) {
        return null;
      }
      const trimmed = name.trim();
      if (!trimmed) {
        return null;
      }
      haptic.light();

      const groupsKey = groupsGetQueryKey({
        path: { assistant_id: assistantId },
      });
      await queryClient.cancelQueries({ queryKey: groupsKey });

      const optimisticId = `optimistic-${Date.now()}`;
      appendGroup(queryClient, assistantId, {
        id: optimisticId,
        name: trimmed,
        icon: icon ?? null,
        sortPosition: 0,
        isSystemGroup: false,
      });

      try {
        const created = await createGroupAsync({
          path: { assistant_id: assistantId },
          // `icon` is gated behind useSupportsGroupIcons at the dialog:
          // callers pass `undefined` against assistants that predate it,
          // which keeps the field off the wire.
          body: icon != null ? { name: trimmed, icon } : { name: trimmed },
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
    async (groupId: string, name: string, icon?: string | null) => {
      if (!assistantId) {
        return;
      }
      const currentGroup = conversationGroups.find((g) => g.id === groupId);
      const currentName = currentGroup?.name ?? "";
      const currentIcon = currentGroup?.icon ?? null;
      const trimmed = name.trim();
      // `icon === undefined` means "leave unchanged" (picker hidden by the
      // backwards-compat gate); `null` explicitly clears the icon.
      const iconChanged = icon !== undefined && icon !== currentIcon;
      if (!trimmed || (trimmed === currentName && !iconChanged)) {
        return;
      }

      const groupsKey = groupsGetQueryKey({
        path: { assistant_id: assistantId },
      });
      await queryClient.cancelQueries({ queryKey: groupsKey });

      patchGroup(queryClient, assistantId, groupId, {
        name: trimmed,
        ...(iconChanged ? { icon } : {}),
      });

      try {
        await patchGroupAsync({
          path: { assistant_id: assistantId, groupId },
          body: { name: trimmed, ...(iconChanged ? { icon } : {}) },
        } as Options<GroupsByGroupIdPatchData>);
      } catch {
        patchGroup(queryClient, assistantId, groupId, {
          name: currentName,
          ...(iconChanged ? { icon: currentIcon } : {}),
        });
      } finally {
        void queryClient.invalidateQueries({ queryKey: groupsKey });
        /* The section index carries the group's name and icon, and the
           daemon suppresses sync echo to this client, so the rename settle
           is the index's only local refresh. Create needs no counterpart: a
           new group is empty and an empty group has no index row. */
        void queryClient.invalidateQueries({
          queryKey: sidebarSectionsQueryKey(assistantId),
        });
      }
    },
    [assistantId, conversationGroups, queryClient, patchGroupAsync],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (!assistantId) {
        return;
      }
      haptic.medium();

      const groupsKey = groupsGetQueryKey({
        path: { assistant_id: assistantId },
      });
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
