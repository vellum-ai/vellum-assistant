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

import type { DisplayMessage } from "@/domains/chat/utils/reconcile.js";
import { clearQueueStatus } from "@/domains/chat/hooks/stream-message-updaters.js";
import { useTurnStore } from "@/domains/messaging/turn-store.js";
import { deleteQueuedMessage, steerToMessage } from "@/domains/chat/api/messages.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseMessageQueueParams {
  assistantId: string | null;
  activeConversationKey: string | null;
  messages: DisplayMessage[];

  // Refs
  pendingQueuedStableIdsRef: MutableRefObject<string[]>;
  requestIdToStableIdRef: MutableRefObject<Map<string, string>>;
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
  activeConversationKey,
  messages,
  pendingQueuedStableIdsRef,
  requestIdToStableIdRef,
  pendingLocalDeletionsRef,
  setMessages,
  setInput,
}: UseMessageQueueParams) {
  /** Remove an optimistically-added queued message and its tracking state. */
  const revertQueuedMessage = useCallback(
    (stableId: string) => {
      setMessages((prev) => prev.filter((m) => m.stableId !== stableId));
      pendingQueuedStableIdsRef.current = pendingQueuedStableIdsRef.current.filter(
        (id) => id !== stableId,
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
    (stableId: string) => {
      if (!assistantId || !activeConversationKey) {
        return;
      }
      let targetRequestId: string | undefined;
      for (const [reqId, sId] of requestIdToStableIdRef.current.entries()) {
        if (sId === stableId) {
          targetRequestId = reqId;
          break;
        }
      }
      setMessages((prev) => prev.filter((m) => m.stableId !== stableId));
      if (targetRequestId) {
        void deleteQueuedMessage(assistantId, activeConversationKey, targetRequestId);
      } else {
        pendingLocalDeletionsRef.current.add(stableId);
        useTurnStore.getState().deleteQueuedMessage();
      }
    },
    [assistantId, activeConversationKey],
  );

  const handleCancelAllQueued = useCallback(() => {
    for (const msg of queuedMessages) {
      handleCancelQueuedMessage(msg.stableId);
    }
  }, [queuedMessages, handleCancelQueuedMessage]);

  const handleSteerMessage = useCallback(
    (stableId: string) => {
      if (!assistantId || !activeConversationKey) {
        return;
      }
      let targetRequestId: string | undefined;
      for (const [reqId, sId] of requestIdToStableIdRef.current.entries()) {
        if (sId === stableId) {
          targetRequestId = reqId;
          break;
        }
      }
      if (targetRequestId) {
        setMessages((prev) => clearQueueStatus(prev, stableId));
        steerToMessage(assistantId, activeConversationKey, targetRequestId).then(
          (ok) => {
            if (!ok) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.stableId === stableId
                    ? { ...m, queueStatus: "queued" as const }
                    : m,
                ),
              );
            }
          },
        );
      }
    },
    [assistantId, activeConversationKey],
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
    handleCancelQueuedMessage(tail.stableId);
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
