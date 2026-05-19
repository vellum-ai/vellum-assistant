
import * as Sentry from "@sentry/react";
import { type Dispatch, useCallback } from "react";

import type { ConversationListAction } from "@/domains/conversations/conversation-list-store.js";

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
 * Each action applies an optimistic update via `dispatchConversationList`
 * before hitting the API. On failure, create/rename roll back optimistically;
 * delete refetches the full conversation list for accuracy.
 *
 * @param dispatchConversationList - Dispatch function from the
 *   `conversationListReducer`. Used for all optimistic group mutations.
 * @returns Stable callbacks: `handleCreateGroup`, `handleRenameGroup`,
 *   `handleDeleteGroup`.
 */
interface UseConversationGroupActionsParams {
  assistantId: string | null;
  conversationGroups: ConversationGroup[];
  dispatchConversationList: Dispatch<ConversationListAction>;
  refreshConversations: () => Promise<void>;
}

export function useConversationGroupActions({
  assistantId,
  conversationGroups,
  dispatchConversationList,
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
    dispatchConversationList({ type: "APPEND_GROUP", group: { id: optimisticId, name: trimmed, sortPosition: 0, isSystemGroup: false } });

    try {
      const created = await createGroup(assistantId, trimmed);
      dispatchConversationList({ type: "REPLACE_OPTIMISTIC_GROUP", optimisticId, group: created });
    } catch (err) {
      dispatchConversationList({ type: "REMOVE_GROUP", groupId: optimisticId });
      Sentry.captureException(err, {
        tags: { context: "createGroup" },
      });
    }
  }, [assistantId, dispatchConversationList]);

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

      dispatchConversationList({ type: "PATCH_GROUP", groupId, patch: { name: trimmed } });

      try {
        await updateGroup(assistantId, groupId, { name: trimmed });
      } catch (err) {
        dispatchConversationList({ type: "PATCH_GROUP", groupId, patch: { name: current } });
        Sentry.captureException(err, {
          tags: { context: "renameGroup" },
        });
      }
    },
    [assistantId, conversationGroups, dispatchConversationList],
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (!assistantId) return;
      haptic.medium();

      dispatchConversationList({ type: "DELETE_GROUP_AND_RESET_CONVERSATIONS", groupId });

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
    [assistantId, dispatchConversationList, refreshConversations],
  );

  return {
    handleCreateGroup,
    handleRenameGroup,
    handleDeleteGroup,
  };
}
