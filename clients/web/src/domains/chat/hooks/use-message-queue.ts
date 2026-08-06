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

import { useCallback, useMemo } from "react";

import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  clearQueueStatus,
  markMessageQueued,
} from "@/domains/chat/utils/stream-updaters/shared";
import { steerToMessage } from "@/domains/chat/api/messages";
import { useComposerStore } from "@/domains/chat/composer-store";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import { confirmQueuedMessageDeletion } from "@/domains/chat/queue-cancellation";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { messageMatchesKey } from "@/domains/chat/utils/message-identity";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseMessageQueueParams {
  assistantId: string | null;
  activeConversationId: string | null;
}

function requestIdForQueuedMessage(messageId: string): string | undefined {
  const { requestIdToMessageId, snapshot } = useChatSessionStore.getState();
  for (const [requestId, mappedMessageId] of requestIdToMessageId.entries()) {
    if (requestId === messageId || mappedMessageId === messageId) {
      return requestId;
    }
  }
  return snapshot?.messages.find(
    (message) =>
      message.queueStatus === "queued" && messageMatchesKey(message, messageId),
  )?.id;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMessageQueue({
  assistantId,
  activeConversationId,
}: UseMessageQueueParams) {
  const transcriptMessages = useTranscriptMessages();
  const setOptimisticSends = useChatSessionStore.use.setOptimisticSends();
  /** Remove an optimistically-added queued message and its tracking state. */
  const revertQueuedMessage = useCallback(
    (messageId: string) => {
      setOptimisticSends((prev) => prev.filter((m) => m.id !== messageId));
      const queueIds = useChatSessionStore.getState().pendingQueuedMessageIds;
      const idx = queueIds.indexOf(messageId);
      if (idx !== -1) {
        queueIds.splice(idx, 1);
      }
    },
    [setOptimisticSends],
  );

  const queuedMessages = useMemo(
    () =>
      transcriptMessages
        .filter(
          (m) =>
            m.role === "user" &&
            m.queueStatus === "queued" &&
            // Daemon-injected run lifecycle notifications are internal
            // scaffolding, not something the user typed: the transcript already
            // drops them (see `buildTranscriptItems`), and the queue drawer —
            // which offers steer/cancel on a person's own pending prompts —
            // must drop them for the same reason. The daemon keeps them out of
            // its queued snapshot too; this is the client-side half of that
            // invariant.
            !m.isSubagentNotification &&
            !m.isAcpNotification &&
            !m.isBackgroundEventNotification,
        )
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)),
    [transcriptMessages],
  );

  const handleCancelQueuedMessage = useCallback(
    (messageId: string) => {
      if (!assistantId || !activeConversationId) {
        return;
      }
      const targetRequestId = requestIdForQueuedMessage(messageId);
      if (targetRequestId) {
        void confirmQueuedMessageDeletion({
          assistantId,
          conversationId: activeConversationId,
          requestId: targetRequestId,
          messageId,
          setOptimisticSends,
          // Mapping cleanup only. `pendingQueuedCount` moves on the daemon's
          // `message_queued_deleted` broadcast, which lands on this tab too,
          // so decrementing here as well would double-count the cancel.
          onDeleted: () => {
            useChatSessionStore.getState().popRequestIdMapping(targetRequestId);
          },
        });
      } else {
        useChatSessionStore.getState().addPendingLocalDeletion(messageId);
      }
    },
    [assistantId, activeConversationId, setOptimisticSends],
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
      const targetRequestId = requestIdForQueuedMessage(messageId);
      if (targetRequestId) {
        const queuePosition = queuedMessages.find((message) =>
          messageMatchesKey(message, messageId),
        )?.queuePosition;
        const patchMessageCopies = (
          updater: (prev: DisplayMessage[]) => DisplayMessage[],
        ) => {
          setOptimisticSends(updater);
          patchTranscriptMessages(updater);
        };
        const promoteMessage = (prev: DisplayMessage[]) =>
          clearQueueStatus(prev, messageId);
        patchMessageCopies(promoteMessage);
        steerToMessage(assistantId, activeConversationId, targetRequestId).then(
          (result) => {
            if (result === "request_failed") {
              const restoreMessage = (prev: DisplayMessage[]) =>
                markMessageQueued(prev, messageId, queuePosition);
              patchMessageCopies(restoreMessage);
            }
          },
        );
      }
    },
    [assistantId, activeConversationId, queuedMessages, setOptimisticSends],
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
