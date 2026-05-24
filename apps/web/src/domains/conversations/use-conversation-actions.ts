
import * as Sentry from "@sentry/react";
import { type MutableRefObject, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { patchConversation } from "@/domains/conversations/conversation-queries.js";
import { isSlackConversation } from "@/domains/chat/utils/group-conversations.js";

import { haptic } from "@/utils/haptics.js";

import { shouldReturnToBackground } from "@/domains/chat/utils/chat-utils.js";
import { type Conversation, archiveConversation, isBackgroundConversation, markConversationSeen, markConversationUnread, renameConversation, reorderConversations, unarchiveConversation } from "@/domains/chat/api/conversations.js";

// ---------------------------------------------------------------------------
// Helpers — pure functions, no React state
// ---------------------------------------------------------------------------

/**
 * Find the next conversation to switch to after archiving the given one.
 * Skips archived and background/scheduled conversations so the user lands
 * on a normal foreground chat, never on a background job like "Memory
 * Retrospective".
 */
export function findNextConversationId(
  conversations: Conversation[],
  archivedKey: string,
): string | null {
  return (
    conversations.find(
      (c) =>
        c.conversationId !== archivedKey &&
        c.archivedAt == null &&
        !isBackgroundConversation(c),
    )?.conversationId ?? null
  );
}

/**
 * Resolve the target groupId when unpinning a conversation. Checks the
 * pre-pin cache first, then falls back to type-based heuristics that
 * match the macOS client's behaviour.
 */
export function resolveUnpinGroupId(
  conversation: Conversation,
  prePinGroupIds: Map<string, string | undefined>,
): string {
  const stored = prePinGroupIds.get(conversation.conversationId);
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
  activeConversationId: string | null;
  conversations: Conversation[];
  refreshConversations: () => Promise<void>;
  switchConversation: (key: string) => void;
  startNewConversation: (opts?: { silent?: boolean }) => void;
  prePinGroupIdsRef: MutableRefObject<Map<string, string | undefined>>;
}

export function useConversationActions({
  assistantId,
  activeConversationId,
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

      const wasActive =
        conversation.conversationId === activeConversationId;
      let nextKey: string | null = null;
      if (wasActive) {
        nextKey = findNextConversationId(conversations, conversation.conversationId);
      }

      // Snapshot prior `archivedAt` so we can roll back on API failure.
      // `undefined` is the canonical "not archived" value — sidebar
      // grouping filters on `archivedAt == null` (see group-conversations.ts).
      const originalArchivedAt = conversation.archivedAt;

      // Optimistic update: hide the row from the sidebar immediately so it
      // disappears in the same frame as the click, without waiting for the
      // network round trip. Any truthy timestamp is sufficient — the real
      // server-authoritative value gets reconciled by `refreshConversations()`
      // once the API call succeeds.
      patchConversation(queryClient, assistantId, conversation.conversationId, {
        archivedAt: Date.now(),
      });

      // Switch away from the archived conversation before the network call
      // too, so the focused chat never sits on a row that's already been
      // filtered out of the sidebar.
      if (wasActive) {
        if (nextKey) {
          switchConversation(nextKey);
        } else {
          startNewConversation({ silent: true });
        }
      }

      try {
        await archiveConversation(assistantId, conversation.conversationId);
        // Refresh so the optimistic `Date.now()` guess is replaced with the
        // server-authoritative timestamp and any other side effects sync in.
        await refreshConversations();
      } catch (err) {
        // Roll back the optimistic patch so the row reappears in the
        // sidebar — the user's action effectively didn't happen. We
        // intentionally don't try to restore the active-conversation
        // selection: the user has already moved on visually, and yanking
        // them back would be more disorienting than the rolled-back row.
        patchConversation(queryClient, assistantId, conversation.conversationId, {
          archivedAt: originalArchivedAt,
        });
        Sentry.captureException(err, {
          tags: { context: "archiveConversation" },
        });
      }
    },
    [
      activeConversationId,
      assistantId,
      conversations,
      queryClient,
      refreshConversations,
      startNewConversation,
      switchConversation,
    ],
  );

  const handleUnarchiveConversation = useCallback(
    async (conversation: Conversation) => {
      if (!assistantId) return;

      const originalArchivedAt = conversation.archivedAt;

      // Optimistic update: clear `archivedAt` so the row pops back into the
      // active sidebar in the same frame as the click. Mirrors the
      // optimistic archive path above.
      patchConversation(queryClient, assistantId, conversation.conversationId, {
        archivedAt: undefined,
      });

      try {
        await unarchiveConversation(
          assistantId,
          conversation.conversationId,
        );
      } catch (err) {
        // Roll back so the row re-archives in the UI.
        patchConversation(queryClient, assistantId, conversation.conversationId, {
          archivedAt: originalArchivedAt,
        });
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
        await markConversationUnread(assistantId, conversation.conversationId);
        patchConversation(queryClient, assistantId, conversation.conversationId, { hasUnseenLatestAssistantMessage: true });
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
        await markConversationSeen(assistantId, conversation.conversationId);
        patchConversation(queryClient, assistantId, conversation.conversationId, { hasUnseenLatestAssistantMessage: false });
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
          conversation.conversationId,
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

      patchConversation(queryClient, assistantId, conversation.conversationId, { isPinned: newIsPinned, groupId: newGroupId });

      try {
        await reorderConversations(assistantId, [
          {
            conversationId: conversation.conversationId,
            isPinned: newIsPinned,
            groupId: newGroupId,
          },
        ]);
        if (!newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationId);
        }
      } catch (err) {
        if (newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationId);
        }
        patchConversation(queryClient, assistantId, conversation.conversationId, { isPinned: prevIsPinned, groupId: prevGroupId });
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
          conversation.conversationId,
          conversation.groupId,
        );
      }

      patchConversation(queryClient, assistantId, conversation.conversationId, { isPinned: newIsPinned, groupId });

      try {
        await reorderConversations(assistantId, [
          {
            conversationId: conversation.conversationId,
            isPinned: newIsPinned,
            groupId,
          },
        ]);
        if (!newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationId);
        }
      } catch (err) {
        if (newIsPinned) {
          prePinGroupIdsRef.current.delete(conversation.conversationId);
        }
        patchConversation(queryClient, assistantId, conversation.conversationId, { isPinned: prevIsPinned, groupId: prevGroupId });
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

      patchConversation(queryClient, assistantId, conversation.conversationId, { title: trimmed });

      try {
        await renameConversation(
          assistantId,
          conversation.conversationId,
          trimmed,
        );
      } catch (err) {
        patchConversation(queryClient, assistantId, conversation.conversationId, { title: current });
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
