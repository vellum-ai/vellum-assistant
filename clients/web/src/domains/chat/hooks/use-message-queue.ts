/**
 * Queue management for user messages waiting to be sent.
 *
 * When the assistant is already processing a turn, new user messages are
 * queued (posted to the daemon with `queued` status). This hook owns the
 * derived queue list and cancel/edit operations — keeping queue concerns
 * separate from the core send flow.
 *
 * @see useSendMessage — the orchestrator that composes this hook
 */

import {
  useCallback,
  useMemo,
} from "react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { clearQueueStatus } from "@/domains/chat/utils/stream-updaters/shared";
import { useTurnStore } from "@/domains/chat/turn-store";
import { deleteQueuedMessage, steerToMessage } from "@/domains/chat/api/messages";
import { useComposerStore } from "@/domains/chat/composer-store";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseMessageQueueParams {
  assistantId: string | null;
  activeConversationId: string | null;
  messages: DisplayMessage[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMessageQueue({
  assistantId,
  activeConversationId,
  messages,
}: UseMessageQueueParams) {
  const setMessages = useChatSessionStore.use.setMessages();
  /** Remove an optimistically-added queued message and its tracking state. */
  const revertQueuedMessage = useCallback(
    (messageId: string) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      const queueIds = useChatSessionStore.getState().pendingQueuedMessageIds;
      const idx = queueIds.indexOf(messageId);
      if (idx !== -1) queueIds.splice(idx, 1);
    },
    [],
  );

  const queuedMessages = useMemo(
    () =>
      messages
        .filter((m) => m.role === "user" && m.queueStatus === "queued")
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)),
    [messages],
  );

  const handleCancelQueuedMessage = useCallback(
    (messageId: string) => {
      if (!assistantId || !activeConversationId) {
        return;
      }
      let targetRequestId: string | undefined;
      for (const [reqId, mId] of useChatSessionStore.getState().requestIdToMessageId.entries()) {
        if (mId === messageId) {
          targetRequestId = reqId;
          break;
        }
      }
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      if (targetRequestId) {
        void deleteQueuedMessage(assistantId, activeConversationId, targetRequestId);
      } else {
        useChatSessionStore.getState().addPendingLocalDeletion(messageId);
        useTurnStore.getState().deleteQueuedMessage();
      }
    },
    [assistantId, activeConversationId],
  );

  const handleCancelAllQueued = useCallback(() => {
    for (const msg of queuedMessages) {
      handleCancelQueuedMessage(msg.id);
    }
  }, [queuedMessages, handleCancelQueuedMessage]);

  const handleSteerMessage = useCallback(
    (messageId: string) => {
      if (!assistantId || !activeConversationId) {
        return;
      }
      let targetRequestId: string | undefined;
      for (const [reqId, mId] of useChatSessionStore.getState().requestIdToMessageId.entries()) {
        if (mId === messageId) {
          targetRequestId = reqId;
          break;
        }
      }
      if (targetRequestId) {
        setMessages((prev) => clearQueueStatus(prev, messageId));
        steerToMessage(assistantId, activeConversationId, targetRequestId).then(
          (ok) => {
            if (!ok) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === messageId
                    ? { ...m, queueStatus: "queued" as const }
                    : m,
                ),
              );
            }
          },
        );
      }
    },
    [assistantId, activeConversationId],
  );

  const handleEditQueueTail = useCallback(() => {
    if (queuedMessages.length === 0) {
      return;
    }
    const tail = queuedMessages[queuedMessages.length - 1];
    if (!tail) {
      return;
    }
    useComposerStore.getState().setInput(messagePlainText(tail));
    handleCancelQueuedMessage(tail.id);
  }, [queuedMessages, handleCancelQueuedMessage]);

  return {
    revertQueuedMessage,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  };
}
