import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import { fetchConversationMessages } from "@/domains/chat/api/messages";
import { useComposerStore } from "@/domains/chat/composer-store";
import {
  keepsProcessingMarker,
  useDocumentComposerReplyStore,
} from "@/domains/chat/document-composer-reply-store";
import { isMessageScopedError } from "@/domains/chat/utils/message-scoped-error";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { useTranslation } from "@/i18n";

/**
 * Take down the processing marker the composer's sends raised in
 * `conversationId`, once none of them is left waiting on a reply. Sends still
 * pending keep the activity up, and so does queued work a handoff announced:
 * that work runs on under the marker the handoff left standing, and its own
 * terminal is what takes the marker down.
 */
function clearProcessingWhenSettled(conversationId: string): void {
  if (
    keepsProcessingMarker(
      useDocumentComposerReplyStore.getState(),
      conversationId,
    )
  ) {
    return;
  }
  useConversationStore
    .getState()
    .removeProcessingConversationId(conversationId);
}

/**
 * Move the send carrying the event's nonce under the conversation the event
 * arrived for, and its processing marker with it. On the legacy
 * `conversationKey` path the send is listed under the key it went out with,
 * and the daemon runs it under the row it minted for that key, so the first
 * event that names both the nonce and the row moves the entry before any
 * terminal could pass it by.
 */
function rekeyByNonce(
  conversationId: string,
  clientMessageId: string | undefined,
): void {
  if (clientMessageId === undefined) {
    return;
  }
  const previousConversationId = useDocumentComposerReplyStore
    .getState()
    .rekeyReplyByNonce(clientMessageId, conversationId);
  if (previousConversationId === null) {
    return;
  }
  useConversationStore
    .getState()
    .transferProcessingConversationId(previousConversationId, conversationId);
}

/** Retract every recovery copy correlated with an accepted or deleted send. */
function acceptCorrelatedRecovery(
  clientMessageId: string,
  dropDetachedQueued = true,
): void {
  const replyStore = useDocumentComposerReplyStore.getState();
  const claimed = replyStore.settleClaimedFailedSend(clientMessageId);
  replyStore.dropFailedSend(clientMessageId);
  if (dropDetachedQueued) {
    replyStore.dropDetachedQueuedSend(clientMessageId);
  }
  if (!claimed?.wasActiveBatch) {
    return;
  }
  const active =
    useDocumentComposerReplyStore.getState().activeDocumentComposer;
  if (
    active?.assistantId !== claimed.assistantId ||
    active.surfaceId !== claimed.surfaceId
  ) {
    return;
  }
  useComposerStore
    .getState()
    .replaceRecoveredPayload(
      claimed.before,
      claimed.after ?? undefined,
      "document",
    );
}

/** Whether the active stream still owns the pending send carrying `nonce`. */
function isPendingReply(
  conversationId: string,
  clientMessageId: string,
): boolean {
  return (
    useDocumentComposerReplyStore
      .getState()
      .pendingReplies.get(conversationId)
      ?.some((pending) => pending.clientMessageId === clientMessageId) ?? false
  );
}

/**
 * Fires the document composer's "Assistant replied" toast once the daemon
 * reports a turn complete for a send `useDocumentComposerSubmit` flagged as
 * awaiting a reply (`document-composer-reply-store.ts`), and ends the wait
 * silently when that turn is cancelled or fails instead. A terminal stream
 * event answers every send running in its conversation, since one turn can
 * run a batch of them, and raises one toast for them all. An `error` naming
 * a message is the exception: it ends only the send carrying that nonce, and
 * is the one failure the watcher reports, raising that send's failure toast
 * and holding its message for the document it was composed for, which that
 * document's composer panel takes back.
 *
 * A terminal settles a send only once the stream has acknowledged it as
 * running: the daemon's echo says it took the send in and started its turn,
 * while its queue events say the send is parked behind another turn instead,
 * so that one waits for the dequeue that starts its own.
 *
 * Mounted once in `RootLayout`, above every document host's null guard, so
 * this subscription survives closing the document (`MobileDocumentOverlay`
 * returning `null`) or navigating off the standalone document route while a
 * reply is still in flight. Neither host stays mounted for the life of the
 * chat session, so the watcher cannot live inside either one. Being the one
 * mount that outlives every route, it is also where the waits are dropped on
 * an assistant switch.
 */
export function DocumentComposerReplyWatcher() {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const isOrgReady = useIsOrgReady();

  const reconcileDetachedQueuedReplies = useCallback(
    async (assistantId: string): Promise<void> => {
      if (!isOrgReady) {
        return;
      }
      const detached = [
        ...useDocumentComposerReplyStore.getState().detachedQueuedSends,
      ].filter(([, send]) => send.payload.assistantId === assistantId);
      if (detached.length === 0) {
        return;
      }

      // Reattach before the network read so queue events that arrive as this
      // assistant becomes active can settle the retained send by nonce.
      for (const [clientMessageId, send] of detached) {
        const replyStore = useDocumentComposerReplyStore.getState();
        replyStore.startAwaitingReply(
          send.conversationId,
          clientMessageId,
          send.payload,
        );
        replyStore.acknowledgeReply(
          send.conversationId,
          clientMessageId,
          true,
        );
        useConversationStore
          .getState()
          .addProcessingConversationId(send.conversationId);
      }

      const byConversation = new Map<
        string,
        typeof detached
      >();
      for (const entry of detached) {
        const conversationId = entry[1].conversationId;
        const entries = byConversation.get(conversationId) ?? [];
        entries.push(entry);
        byConversation.set(conversationId, entries);
      }

      for (const [conversationId, entries] of byConversation) {
        let snapshot: Awaited<ReturnType<typeof fetchConversationMessages>>;
        try {
          snapshot = await fetchConversationMessages(
            assistantId,
            conversationId,
          );
        } catch {
          // Keep the payload and the reattached nonce. A later stream event or
          // assistant activation can resolve it without risking a duplicate.
          continue;
        }
        if (
          useResolvedAssistantsStore.getState().activeAssistantId !==
          assistantId
        ) {
          return;
        }

        for (const [clientMessageId, send] of entries) {
          const replyStore = useDocumentComposerReplyStore.getState();
          const stillDetached = replyStore.detachedQueuedSends.get(
            clientMessageId,
          );
          if (stillDetached === undefined) {
            continue;
          }
          const message = snapshot?.messages.find(
            (candidate) => candidate.clientMessageId === clientMessageId,
          );
          if (message?.queueStatus === "queued") {
            continue;
          }
          if (message !== undefined && snapshot?.processing === true) {
            replyStore.dropDetachedQueuedSend(clientMessageId);
            replyStore.markReplyRunning(conversationId, clientMessageId);
            continue;
          }
          if (message === undefined && snapshot?.processing !== false) {
            // The send can be between dequeue and persistence. Only an idle
            // snapshot with neither a queued nor persisted row proves it died.
            continue;
          }

          replyStore.dropDetachedQueuedSend(clientMessageId);
          replyStore.stopAwaitingReply(conversationId, clientMessageId);
          if (message === undefined) {
            replyStore.stashFailedSend(send.payload);
            toast.error(t("documentComposer.sendFailed"));
          }
          clearProcessingWhenSettled(conversationId);
        }
      }
    },
    [isOrgReady, t],
  );

  // One SSE connection follows the active assistant, so a wait held across a
  // switch never sees its reply and would toast on an unrelated turn. The
  // active assistant can change on routes that mount no conversation view
  // (the standalone document route), where nothing else resets per-assistant
  // chat state.
  useEffect(() => {
    let ownerAssistantId =
      useResolvedAssistantsStore.getState().activeAssistantId;
    if (ownerAssistantId !== null) {
      void reconcileDetachedQueuedReplies(ownerAssistantId);
    }
    return useResolvedAssistantsStore.subscribe((state) => {
      const { activeAssistantId } = state;
      if (activeAssistantId === ownerAssistantId) {
        return;
      }
      // Going null is leaving the assistant too (logout, removing the paired
      // assistant, the lifecycle reset), and no terminal for its
      // conversations arrives until it is selected again.
      if (ownerAssistantId !== null) {
        const replyStore = useDocumentComposerReplyStore.getState();
        // The outgoing assistant's connection is detached, so no terminal
        // takes these markers down, and the incoming assistant's attention
        // cleanup passes over conversations its own list does not name. A
        // conversation whose document send settled on a handoff keeps its
        // marker up for the queued work the handoff announced, and that
        // work's terminal rides the same detached connection.
        const strandedConversationIds = new Set([
          ...replyStore.pendingReplies.keys(),
          ...replyStore.handedOffConversationIds,
        ]);
        for (const conversationId of strandedConversationIds) {
          useConversationStore
            .getState()
            .removeProcessingConversationId(conversationId);
        }
        replyStore.clearAwaitingReplies();
        // Leaving every assistant hands the next context nothing, so no
        // message one user wrote is held for whoever signs in next.
        if (activeAssistantId === null) {
          replyStore.clearHeldMessages();
        }
      }
      ownerAssistantId = activeAssistantId;
      if (activeAssistantId !== null) {
        void reconcileDetachedQueuedReplies(activeAssistantId);
      }
    });
  }, [reconcileDetachedQueuedReplies]);

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;

    // The echo is the daemon taking the send in and starting its turn, and it
    // rides the stream ahead of that turn's terminal, so it is what makes the
    // send settleable. A send the daemon has not spoken for yet belongs to no
    // turn, and a terminal that arrives before it belongs to some other one.
    if (event.type === "user_message_echo") {
      if (!event.conversationId) {
        return;
      }
      rekeyByNonce(event.conversationId, event.clientMessageId);
      if (event.clientMessageId !== undefined) {
        acceptCorrelatedRecovery(event.clientMessageId);
      }
      useDocumentComposerReplyStore
        .getState()
        .markReplyRunning(event.conversationId, event.clientMessageId);
      return;
    }

    // The queue ack, not the send's POST response, is what acknowledges a send
    // as queued: it rides the same stream as the terminals below, while the
    // response can return after the running turn has already handed off.
    if (event.type === "message_queued") {
      rekeyByNonce(event.conversationId, event.clientMessageId);
      if (event.clientMessageId !== undefined) {
        acceptCorrelatedRecovery(
          event.clientMessageId,
          isPendingReply(event.conversationId, event.clientMessageId),
        );
      }
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued(event.conversationId, event.clientMessageId);
      return;
    }

    // A requeue puts back the send a dequeue took off the queue, for a turn
    // the daemon could not start, so it is the send that dequeue made running
    // that is queued again rather than whichever send is newest.
    if (event.type === "message_requeued") {
      rekeyByNonce(event.conversationId, event.clientMessageId);
      if (event.clientMessageId !== undefined) {
        acceptCorrelatedRecovery(
          event.clientMessageId,
          isPendingReply(event.conversationId, event.clientMessageId),
        );
      }
      useDocumentComposerReplyStore
        .getState()
        .markReplyRequeued(event.conversationId, event.clientMessageId);
      return;
    }

    // The daemon took the send off the queue for a turn, so it is running and
    // the terminal that ends that turn is its reply.
    if (event.type === "message_dequeued") {
      rekeyByNonce(event.conversationId, event.clientMessageId);
      if (event.clientMessageId !== undefined) {
        acceptCorrelatedRecovery(
          event.clientMessageId,
          isPendingReply(event.conversationId, event.clientMessageId),
        );
      }
      useDocumentComposerReplyStore
        .getState()
        .clearReplyQueued(event.conversationId, event.clientMessageId);
      return;
    }

    // The deleted message was discarded before it ever ran, so no reply is
    // coming for it. Only the nonce names which send that is, and ending a
    // wait on another client's deletion would end the wrong one.
    if (event.type === "message_queued_deleted") {
      const { conversationId, clientMessageId } = event;
      if (!clientMessageId) {
        return;
      }
      rekeyByNonce(conversationId, clientMessageId);
      const replyStore = useDocumentComposerReplyStore.getState();
      acceptCorrelatedRecovery(clientMessageId);
      replyStore.stopAwaitingReply(conversationId, clientMessageId);
      clearProcessingWhenSettled(conversationId);
      return;
    }

    if (
      event.type !== "generation_handoff" &&
      event.type !== "generation_cancelled" &&
      event.type !== "error" &&
      event.type !== "message_failed" &&
      event.type !== "conversation_error" &&
      event.type !== "message_complete"
    ) {
      return;
    }
    // Auxiliary notifier injections (call transcripts, watch summaries) are
    // not a reply the document composer sent a message toward.
    if (event.type === "message_complete" && event.source === "aux") {
      return;
    }
    const { conversationId } = event;
    if (!conversationId) {
      return;
    }
    // A message failure belongs to one queued member while the surrounding
    // turn runs on. Scoped errors are accepted for compatibility with builds
    // that emitted this signal before it had its own discriminator. The nonce,
    // when the sender supplied one, says which message failed.
    if (
      event.type === "message_failed" ||
      (event.type === "error" && isMessageScopedError(event))
    ) {
      const { clientMessageId } = event;
      if (clientMessageId === undefined) {
        return;
      }
      rekeyByNonce(conversationId, clientMessageId);
      const replyStore = useDocumentComposerReplyStore.getState();
      const pending = replyStore.pendingReplies.get(conversationId) ?? [];
      const detached = replyStore.detachedQueuedSends.get(clientMessageId);
      // A nonce naming neither an attached nor switch-detached send is
      // another client's message, and the sends listed here are still owed
      // their own terminals.
      const failed = pending.find((p) => p.clientMessageId === clientMessageId);
      const claimed = replyStore.settleClaimedFailedSend(clientMessageId);
      if (!failed && !detached && !claimed) {
        return;
      }
      replyStore.dropDetachedQueuedSend(clientMessageId);
      replyStore.stopAwaitingReply(conversationId, clientMessageId);
      clearProcessingWhenSettled(conversationId);
      // The daemon reports this failure after the send's own response, by
      // which time the composer has been cleared and told the user the
      // message went out, and on the standalone document route no other
      // handler sees the error.
      toast.error(t("documentComposer.sendFailed"));
      if (failed?.payload && !failed.recovering) {
        replyStore.stashFailedSend(failed.payload);
      } else if (detached) {
        replyStore.stashFailedSend(detached.payload);
      }
      return;
    }
    // Each of these ends the turn that was running (`error` and
    // `conversation_error` are the two the chat stream handlers also treat as
    // turn-ending, `utils/stream-handlers/error-handlers.ts`). One turn can
    // run a batch of sends the daemon dequeued together, so this answers every
    // send running in the conversation. Sends still queued wait for their own
    // dequeue, sends the daemon has not spoken for yet belong to no turn, and
    // a terminal with none of these sends running belongs to a turn started
    // elsewhere.
    const settled = useDocumentComposerReplyStore
      .getState()
      .settleRunningReplies(conversationId);
    const activeAssistantId =
      useResolvedAssistantsStore.getState().activeAssistantId;
    if (activeAssistantId !== null) {
      void reconcileDetachedQueuedReplies(activeAssistantId);
    }
    // A handoff leaves the marker up for the queued work it announces, and the
    // conversation is named as handed off. The next terminal there that is not
    // itself a handoff takes the marker down, whether or not it answers a send
    // of this composer's: on the standalone document route no chat view is
    // mounted to end that turn, and the graduation sweep in
    // `use-attention-tracking.ts` passes over the conversation on screen.
    if (settled === 0) {
      if (
        event.type !== "generation_handoff" &&
        useDocumentComposerReplyStore.getState().clearHandedOff(conversationId)
      ) {
        clearProcessingWhenSettled(conversationId);
      }
      // A terminal none of these sends is running in has no reply to announce.
      return;
    }
    if (event.type === "generation_handoff") {
      useDocumentComposerReplyStore.getState().markHandedOff(conversationId);
    } else {
      useDocumentComposerReplyStore.getState().clearHandedOff(conversationId);
      clearProcessingWhenSettled(conversationId);
    }
    // The daemon emits a handoff in place of `message_complete` when the turn
    // finishes with more messages queued behind it, so the reply is done. The
    // three failure terminals answer the sends with nothing to announce.
    if (
      event.type !== "message_complete" &&
      event.type !== "generation_handoff"
    ) {
      return;
    }
    // The conversation belongs to the assistant that replied, so the action
    // is inert once the user has switched to a different one.
    const repliedAssistantId =
      useResolvedAssistantsStore.getState().activeAssistantId;
    toast.success(t("documentComposer.assistantRepliedToast"), {
      action: {
        label: t("documentComposer.viewReply"),
        onClick: () => {
          if (
            useResolvedAssistantsStore.getState().activeAssistantId !==
            repliedAssistantId
          ) {
            return;
          }
          navigateToConversation(navigate, conversationId);
        },
      },
    });
  });

  return null;
}
