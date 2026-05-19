
import * as Sentry from "@sentry/react";
import { type Dispatch, type MutableRefObject, useCallback } from "react";

import type { ConversationListAction } from "@/domains/chat/lib/conversation-list-state.js";
import { patchConversation as _patchConversation } from "@/domains/chat/lib/conversation-list-state.js";
import { isSlackConversation } from "@/domains/chat/lib/groupConversations.js";

import {
  type Conversation,
  archiveConversation,
  markConversationSeen,
  markConversationUnread,
  renameConversation,
  reorderConversations,
  unarchiveConversation,
} from "@/domains/chat/lib/api.js";
import { haptic } from "@/utils/haptics.js";

import { shouldReturnToBackground } from "@/domains/chat/utils/chat-utils.js";

// ---------------------------------------------------------------------------
// Helpers — pure functions, no React state
// ---------------------------------------------------------------------------

/**
 * Resolve the target groupId when unpinning a conversation. Checks the
 * pre-pin cache first, then falls back to type-based heuristics that
 * match the macOS client's behaviour.
 */
export function resolveUnpinGroupId(
  conversation: Conversation,
  prePinGroupIds: Map<string, string | undefined>,
): string {
  const stored = prePinGroupIds.get(conversation.conversationKey);
  if (stored) return stored;
  if (isSlackConversation(conversation)) return "system:all";
  if (shouldReturnToBackground(conversation)) return "system:background";
  if (conversation.conversationType === "scheduled") return "system:scheduled";
  if (conversation.conversationType === "background") return "system:background";
  return "system:all";
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Conversation CRUD actions: archive, unarchive, rename, mark read/unread,
 * pin/unpin, and move between groups.
 *
 * All mutations apply an optimistic update via `dispatchConversationList`
 * before calling the API, and roll back on failure.
 *
 * @param dispatchConversationList - Dispatch function from the
 *   `conversationListReducer`. Used for all optimistic state updates.
 * @returns Stable callbacks for each conversation action.
 */
interface UseConversationActionsParams {
  assistantId: string | null;
  activeConversationKey: string | null;
  conversations: Conversation[];
  dispatchConversationList: Dispatch<ConversationListAction>;
  refreshConversations: () => Promise<void>;
  switchConversation: (key: string) => void;
  startNewConversation: (opts?: { silent?: boolean }) => void;
  prePinGroupIdsRef: MutableRefObject<Map<string, string | undefined>>;
}

export function useConversationActions({
  assistantId,
  activeConversationKey,
  conversations,
  dispatchConversationList,
  refreshConversations,
  switchConversation,
  startNewConversation,
  prePinGroupIdsRef,
}: UseConversationActionsParams) {
  const handleArchiveConversation = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      haptic.medium();
      try {
        const wasActive =
          conversation.conversationKey === activeConversationKey;
        let nextKey: string | null = null;
        if (wasActive) {
          nextKey =
            conversations.find(
              (c) =>
                c.conversationKey !== conversation.conversationKey &&
                c.archivedAt == null,
            )?.conversationKey ?? null;
        }

        await archiveConversation(assistantId, conversation.conversationKey);
        await refreshConversations();

        if (wasActive) {
          if (nextKey) {
            switchConversation(nextKey);
          } else {
            startNewConversation({ silent: true });
          }
        }
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "archiveConversation" },
        });
      }
    },
    [
      activeConversationKey,
      assistantId,
      conversations,
      refreshConversations,
      startNewConversation,
      switchConversation,
    ],
  );

  const handleUnarchiveConversation = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      try {
        await unarchiveConversation(
          assistantId,
          conversation.conversationKey,
        );
        dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { archivedAt: undefined } });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "unarchiveConversation" },
        });
      }
    },
    [assistantId, dispatchConversationList],
  );

  const handleMarkConversationUnread = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      if (
        conversation.hasUnseenLatestAssistantMessage ||
        !conversation.latestAssistantMessageAt
      ) {
        return;
      }
      try {
        await markConversationUnread(assistantId, conversation.conversationKey);
        dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { hasUnseenLatestAssistantMessage: true } });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "markConversationUnread" },
        });
      }
    },
    [assistantId, dispatchConversationList],
  );

  const handleMarkConversationRead = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      if (!conversation.hasUnseenLatestAssistantMessage) return;
      try {
        await markConversationSeen(assistantId, conversation.conversationKey);
        dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { hasUnseenLatestAssistantMessage: false } });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "markConversationRead" },
        });
      }
    },
    [assistantId, dispatchConversationList],
  );

  const handleTogglePinConversation = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      haptic.light();

      const currentlyPinned =
        conversation.isPinned || conversation.groupId === "system:pinned";
      const newIsPinned = !currentlyPinned;

      let newGroupId: string;
      if (newIsPinned) {
        prePinGroupIdsRef.current.set(
          conversation.conversationKey,
          conversation.groupId,
        );
        newGroupId = "system:pinned";
      } else {
        newGroupId = resolveUnpinGroupId(
          conversation,
          prePinGroupIdsRef.current,
        );
      }

      const prevIsPinned = conversation.isPinned;
      const prevGroupId = conversation.groupId;

      dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { isPinned: newIsPinned, groupId: newGroupId } });

      try {
        await reorderConversations(assistantId, [
          {
            conversationId: conversation.conversationKey,
            isPinned: newIsPinned,
            groupId: newGroupId,
          },
        ]);
        if (!newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationKey);
        }
      } catch (err) {
        if (newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationKey);
        }
        dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { isPinned: prevIsPinned, groupId: prevGroupId } });
        Sentry.captureException(err, {
          tags: { context: "togglePinConversation" },
        });
      }
    },
    [assistantId, prePinGroupIdsRef, dispatchConversationList],
  );

  const handleMoveToGroup = useCallback(
    async (conversation: Conversation, groupId: string) => {
      if (!assistantId) return;
      haptic.light();

      const prevIsPinned = conversation.isPinned;
      const prevGroupId = conversation.groupId;
      const newIsPinned = groupId === "system:pinned";

      if (newIsPinned) {
        prePinGroupIdsRef.current.set(
          conversation.conversationKey,
          conversation.groupId,
        );
      }

      dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { isPinned: newIsPinned, groupId } });

      try {
        await reorderConversations(assistantId, [
          {
            conversationId: conversation.conversationKey,
            isPinned: newIsPinned,
            groupId,
          },
        ]);
        if (!newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationKey);
        }
      } catch (err) {
        if (newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationKey);
        }
        dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { isPinned: prevIsPinned, groupId: prevGroupId } });
        Sentry.captureException(err, {
          tags: { context: "moveToGroup" },
        });
      }
    },
    [assistantId, prePinGroupIdsRef, dispatchConversationList],
  );

  const handleRemoveFromGroup = useCallback(
    (conversation: Conversation) => {
      void handleMoveToGroup(conversation, "system:all");
    },
    [handleMoveToGroup],
  );

  const handleRenameConversation = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      const current = conversation.title ?? "";
      const next =
        typeof window === "undefined"
          ? null
          : window.prompt("Rename conversation", current);
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === current) return;

      dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { title: trimmed } });

      try {
        await renameConversation(
          assistantId,
          conversation.conversationKey,
          trimmed,
        );
      } catch (err) {
        dispatchConversationList({ type: "PATCH_CONVERSATION", key: conversation.conversationKey, patch: { title: current } });
        Sentry.captureException(err, {
          tags: { context: "renameConversation" },
        });
      }
    },
    [assistantId, dispatchConversationList],
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
  };
}
