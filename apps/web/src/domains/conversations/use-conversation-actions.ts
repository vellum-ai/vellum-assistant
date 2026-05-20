
import * as Sentry from "@sentry/react";
import { type MutableRefObject, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { patchConversation } from "@/domains/conversations/conversation-queries.js";
import { isSlackConversation } from "@/domains/chat/utils/groupConversations.js";

import { haptic } from "@/utils/haptics.js";

import { shouldReturnToBackground } from "@/domains/chat/utils/chat-utils.js";
import { type Conversation, archiveConversation, markConversationSeen, markConversationUnread, renameConversation, reorderConversations, unarchiveConversation } from "@/domains/chat/api/conversations.js";

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
 * All mutations apply optimistic updates against the TanStack Query cache
 * via `patchConversation` before calling the API, and roll back on
 * failure.
 *
 * @returns Stable callbacks for each conversation action.
 */
interface UseConversationActionsParams {
  assistantId: string | null;
  activeConversationKey: string | null;
  conversations: Conversation[];
  refreshConversations: () => Promise<void>;
  switchConversation: (key: string) => void;
  startNewConversation: (opts?: { silent?: boolean }) => void;
  prePinGroupIdsRef: MutableRefObject<Map<string, string | undefined>>;
}

export function useConversationActions({
  assistantId,
  activeConversationKey,
  conversations,
  refreshConversations,
  switchConversation,
  startNewConversation,
  prePinGroupIdsRef,
}: UseConversationActionsParams) {
  const queryClient = useQueryClient();

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
        patchConversation(queryClient, assistantId, conversation.conversationKey, { archivedAt: undefined });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "unarchiveConversation" },
        });
      }
    },
    [assistantId, queryClient],
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
        patchConversation(queryClient, assistantId, conversation.conversationKey, { hasUnseenLatestAssistantMessage: true });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "markConversationUnread" },
        });
      }
    },
    [assistantId, queryClient],
  );

  const handleMarkConversationRead = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;
      if (!conversation.hasUnseenLatestAssistantMessage) return;
      try {
        await markConversationSeen(assistantId, conversation.conversationKey);
        patchConversation(queryClient, assistantId, conversation.conversationKey, { hasUnseenLatestAssistantMessage: false });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { context: "markConversationRead" },
        });
      }
    },
    [assistantId, queryClient],
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

      patchConversation(queryClient, assistantId, conversation.conversationKey, { isPinned: newIsPinned, groupId: newGroupId });

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
        patchConversation(queryClient, assistantId, conversation.conversationKey, { isPinned: prevIsPinned, groupId: prevGroupId });
        Sentry.captureException(err, {
          tags: { context: "togglePinConversation" },
        });
      }
    },
    [assistantId, prePinGroupIdsRef, queryClient],
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

      patchConversation(queryClient, assistantId, conversation.conversationKey, { isPinned: newIsPinned, groupId });

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
        patchConversation(queryClient, assistantId, conversation.conversationKey, { isPinned: prevIsPinned, groupId: prevGroupId });
        Sentry.captureException(err, {
          tags: { context: "moveToGroup" },
        });
      }
    },
    [assistantId, prePinGroupIdsRef, queryClient],
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

      patchConversation(queryClient, assistantId, conversation.conversationKey, { title: trimmed });

      try {
        await renameConversation(
          assistantId,
          conversation.conversationKey,
          trimmed,
        );
      } catch (err) {
        patchConversation(queryClient, assistantId, conversation.conversationKey, { title: current });
        Sentry.captureException(err, {
          tags: { context: "renameConversation" },
        });
      }
    },
    [assistantId, queryClient],
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
