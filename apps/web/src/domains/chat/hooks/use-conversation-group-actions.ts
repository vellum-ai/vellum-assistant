
import * as Sentry from "@sentry/react";
import { useCallback } from "react";

import { useConversationListStore } from "@/domains/conversations/conversation-list-store.js";

import {
  type ConversationGroup,
  createGroup,
  deleteGroup,
  updateGroup,
} from "@/domains/chat/lib/api.js";
import { haptic } from "@/utils/haptics.js";

// ---------------------------------------------------------------------------
// Helpers — pure functions, no React state
// ---------------------------------------------------------------------------

/**
 * Immutably patch the group matching `id`, leaving all others untouched.
 */
export function patchGroup(
  groups: ConversationGroup[],
  id: string,
  patch: Partial<ConversationGroup>,
): ConversationGroup[] {
  return groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Folder/group CRUD actions: create, rename, and delete conversation groups.
 *
 * Each action applies an optimistic update via `useConversationListStore`
 * before hitting the API. On failure, create/rename roll back optimistically;
 * delete refetches the full conversation list for accuracy.
 *
 * @returns Stable callbacks: `handleCreateGroup`, `handleRenameGroup`,
 *   `handleDeleteGroup`.
 */
interface UseConversationGroupActionsParams {
  assistantId: string | null;
  conversationGroups: ConversationGroup[];
  refreshConversations: () => Promise<void>;
}

export function useConversationGroupActions({
  assistantId,
  conversationGroups,
  refreshConversations,
}: UseConversationGroupActionsParams) {
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
    useConversationListStore.getState().appendGroup({ id: optimisticId, name: trimmed, sortPosition: 0, isSystemGroup: false });

    try {
      const created = await createGroup(assistantId, trimmed);
      useConversationListStore.getState().replaceOptimisticGroup(optimisticId, created);
    } catch (err) {
      useConversationListStore.getState().removeGroup(optimisticId);
      Sentry.captureException(err, {
        tags: { context: "createGroup" },
      });
    }
  }, [assistantId]);

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

      useConversationListStore.getState().patchGroup(groupId, { name: trimmed });

      try {
        await updateGroup(assistantId, groupId, { name: trimmed });
      } catch (err) {
        useConversationListStore.getState().patchGroup(groupId, { name: current });
        Sentry.captureException(err, {
          tags: { context: "renameGroup" },
        });
      }
    },
    [assistantId, conversationGroups],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (!assistantId) return;
      haptic.medium();

      useConversationListStore.getState().deleteGroupAndResetConversations(groupId);

      try {
        await deleteGroup(assistantId, groupId);
      } catch (err) {
        // Rollback is imprecise — we can't distinguish conversations that
        // already had no groupId from those we just cleared — so refetch
        // both groups and conversations for accuracy.
        refreshConversations();
        Sentry.captureException(err, {
          tags: { context: "deleteGroup" },
        });
      }
    },
    [assistantId, refreshConversations],
  );

  return {
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
  };
}
