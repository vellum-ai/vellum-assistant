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

import { deleteQueuedMessage } from "@/domains/chat/lib/api.js";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";
import type { DomainEvent } from "@/domains/messaging/turn-store.js";

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
  dispatchTurn: Dispatch<DomainEvent>;
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
  dispatchTurn,
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
        dispatchTurn({ type: "MESSAGE_QUEUED_DELETED" });
      }
    },
    [assistantId, activeConversationKey],
  );

  const handleCancelAllQueued = useCallback(() => {
    for (const msg of queuedMessages) {
      handleCancelQueuedMessage(msg.stableId);
    }
  }, [queuedMessages, handleCancelQueuedMessage]);

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
    handleEditQueueTail,
  };
}
