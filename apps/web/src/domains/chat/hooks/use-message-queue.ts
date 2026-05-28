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
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useMemo,
} from "react";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { clearQueueStatus } from "@/domains/chat/hooks/stream-message-updaters";
import { useTurnStore } from "@/stores/turn-store";
import { deleteQueuedMessage, steerToMessage } from "@/domains/chat/api/messages";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseMessageQueueParams {
  assistantId: string | null;
  activeConversationId: string | null;
  messages: DisplayMessage[];

  // Refs
  pendingQueuedMessageIdsRef: MutableRefObject<string[]>;
  requestIdToMessageIdRef: MutableRefObject<Map<string, string>>;
  pendingLocalDeletionsRef: MutableRefObject<Set<string>>;

  // State setters
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setInput: Dispatch<SetStateAction<string>>;

}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMessageQueue({
  assistantId,
  activeConversationId,
  messages,
  pendingQueuedMessageIdsRef,
  requestIdToMessageIdRef,
  pendingLocalDeletionsRef,
  setMessages,
  setInput,
}: UseMessageQueueParams) {
  /** Remove an optimistically-added queued message and its tracking state. */
  const revertQueuedMessage = useCallback(
    (messageId: string) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      pendingQueuedMessageIdsRef.current = pendingQueuedMessageIdsRef.current.filter(
        (id) => id !== messageId,
      );
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
      for (const [reqId, mId] of requestIdToMessageIdRef.current.entries()) {
        if (mId === messageId) {
          targetRequestId = reqId;
          break;
        }
      }
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      if (targetRequestId) {
        void deleteQueuedMessage(assistantId, activeConversationId, targetRequestId);
      } else {
        pendingLocalDeletionsRef.current.add(messageId);
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
      for (const [reqId, mId] of requestIdToMessageIdRef.current.entries()) {
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
    setInput(tail.content);
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
