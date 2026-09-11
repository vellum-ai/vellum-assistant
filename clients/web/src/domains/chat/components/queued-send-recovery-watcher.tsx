import { useCallback, useEffect } from "react";

import { toast } from "@vellumai/design-library/components/toast";

import { fetchConversationMessages } from "@/domains/chat/api/messages";
import { useComposerStore } from "@/domains/chat/composer-store";
import { isMessageScopedError } from "@/domains/chat/utils/message-scoped-error";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useTranslation } from "@/i18n";

/** Settle every local recovery copy after history or the stream finds the row. */
function acceptQueuedSend(clientMessageId: string): void {
  const composer = useComposerStore.getState();
  const recoveryWasClaimed =
    composer.claimedQueuedSendIds.has(clientMessageId);
  const held = composer.takeQueuedSend(clientMessageId);
  if (held === null) {
    return;
  }
  const payload = {
    content: held.content,
    attachments: held.attachments,
  };
  if (!composer.dropFailedSendByClientMessageId(clientMessageId)) {
    composer.dropFailedSend(held.assistantId, held.conversationId, payload);
  }
  composer.clearRestoredDraft(
    held.assistantId,
    held.conversationId,
    held.content,
  );
  const activeAssistantId =
    useResolvedAssistantsStore.getState().activeAssistantId;
  const activeConversationId =
    useConversationStore.getState().activeConversationId;
  if (
    recoveryWasClaimed &&
    activeAssistantId === held.assistantId &&
    activeConversationId === held.conversationId
  ) {
    composer.replaceRecoveredPayload(payload);
  }
}

/**
 * Hands a queued send's message back to the conversation it was written in
 * when the daemon refuses to persist it.
 *
 * A send the daemon takes onto its queue is answered long after its own
 * response, and the answer can be a refusal. By then the composer has been
 * cleared and told the user the message went out, and the user is free to
 * have opened another thread: the conversation view filters that failure out
 * (it names a conversation other than the stream's, see
 * `use-stream-event-handler.ts`) and the optimistic row that held the text is
 * gone with the transcript it belonged to. `useSendMessage` keeps what such a
 * send carried in `composer-store`, and this is what answers for it: the
 * daemon's echo says the message is persisted and the copy can go, and a
 * failure scoped to that message hands the copy to the conversation it was
 * composed for, whose composer takes it back the next time it is on screen
 * with nothing in it.
 *
 * The conversation on screen is not this watcher's to answer for: its own
 * error handler owns that one, with or without an optimistic row to roll back
 * (`utils/stream-handlers/error-handlers.ts`), and takes the copy itself. This
 * watcher owns the conversations that handler never sees, the ones the stream
 * filters the failure out of.
 *
 * Mounted once in `RootLayout`, since no conversation view is mounted for the
 * thread a queued send was left behind in, and the send outlives every route
 * the user can navigate to while waiting for it.
 */
export function QueuedSendRecoveryWatcher() {
  const { t } = useTranslation("chat");
  const isOrgReady = useIsOrgReady();

  const reconcileQueuedSends = useCallback(
    async (assistantId: string): Promise<void> => {
      if (!isOrgReady) {
        return;
      }
      const retained = [...useComposerStore.getState().queuedSends].filter(
        ([, send]) => send.assistantId === assistantId,
      );
      const byConversation = new Map<string, typeof retained>();
      for (const entry of retained) {
        const entries = byConversation.get(entry[1].conversationId) ?? [];
        entries.push(entry);
        byConversation.set(entry[1].conversationId, entries);
      }

      for (const [conversationId, entries] of byConversation) {
        let snapshot: Awaited<ReturnType<typeof fetchConversationMessages>>;
        try {
          snapshot = await fetchConversationMessages(
            assistantId,
            conversationId,
          );
        } catch {
          continue;
        }
        if (
          useResolvedAssistantsStore.getState().activeAssistantId !==
          assistantId
        ) {
          return;
        }

        for (const [clientMessageId, send] of entries) {
          const composer = useComposerStore.getState();
          const current = composer.queuedSends.get(clientMessageId);
          if (
            current?.assistantId !== assistantId ||
            current.conversationId !== conversationId
          ) {
            continue;
          }
          const message = snapshot?.messages.find(
            (candidate) => candidate.clientMessageId === clientMessageId,
          );
          if (message?.queueStatus === "queued") {
            continue;
          }
          if (message !== undefined) {
            acceptQueuedSend(clientMessageId);
            continue;
          }
          if (snapshot?.processing !== false) {
            continue;
          }

          // A failure event can be missed while another assistant owns the
          // stream. Keep the accepted-send nonce alive, but expose a recovery
          // correlated with it so a late echo can retract the exact draft.
          if (
            !composer.claimedQueuedSendIds.has(clientMessageId) &&
            composer.stashFailedSend(
              send.assistantId,
              send.conversationId,
              {
                content: send.content,
                attachments: send.attachments,
              },
              clientMessageId,
            )
          ) {
            toast.error(t("queuedSendRecovery.heldForConversation"));
          }
        }
      }
    },
    [isOrgReady, t],
  );

  useEffect(() => {
    let ownerAssistantId =
      useResolvedAssistantsStore.getState().activeAssistantId;
    if (ownerAssistantId !== null) {
      void reconcileQueuedSends(ownerAssistantId);
    }
    return useResolvedAssistantsStore.subscribe((state) => {
      const { activeAssistantId } = state;
      if (activeAssistantId === ownerAssistantId) {
        return;
      }
      ownerAssistantId = activeAssistantId;
      if (activeAssistantId === null) {
        useComposerStore.getState().clearHeldSends();
        return;
      }
      void reconcileQueuedSends(activeAssistantId);
    });
  }, [reconcileQueuedSends]);

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;

    // The echo is the daemon speaking for the message: it is persisted, and
    // the client copy has nothing left to answer for. A draft written back
    // for it while its request looked lost goes too, while it still reads
    // exactly the sent text, so a message the daemon took is never offered
    // for sending twice.
    if (event.type === "user_message_echo") {
      const { clientMessageId } = event;
      if (clientMessageId === undefined) {
        return;
      }
      acceptQueuedSend(clientMessageId);
      return;
    }

    // A queued message the user deleted never runs, so the daemon owes no
    // answer for it and the copy has nothing left to recover into.
    if (event.type === "message_queued_deleted") {
      const { clientMessageId } = event;
      if (clientMessageId === undefined) {
        return;
      }
      useComposerStore.getState().dropQueuedSend(clientMessageId);
      return;
    }

    if (
      event.type !== "message_failed" &&
      (event.type !== "error" || !isMessageScopedError(event))
    ) {
      return;
    }
    const { clientMessageId } = event;
    if (clientMessageId === undefined) {
      return;
    }
    const composer = useComposerStore.getState();
    const held = composer.queuedSends.get(clientMessageId);
    // A nonce naming nothing held here is another client's send, or one this
    // tab has already answered for.
    if (held === undefined) {
      return;
    }
    // A chat view mounted for this conversation is looking at the failure too
    // and owns everything about it, the copy included, so the entry is left
    // exactly where that view's handler expects to find it. With no chat view
    // handling the conversation's stream, on the standalone document route or
    // any other, nothing else will answer, and the active conversation id
    // alone says nothing about that: it persists across those routes.
    if (
      useConversationStore.getState().streamHandledConversationId ===
      held.conversationId
    ) {
      return;
    }
    const recoveryWasClaimed =
      composer.claimedQueuedSendIds.has(clientMessageId);
    composer.takeQueuedSend(clientMessageId);
    if (!recoveryWasClaimed) {
      composer.dropFailedSendByClientMessageId(clientMessageId);
      composer.stashFailedSend(held.assistantId, held.conversationId, {
        content: held.content,
        attachments: held.attachments,
      });
    }
    toast.error(t("queuedSendRecovery.heldForConversation"));
  });

  return null;
}
