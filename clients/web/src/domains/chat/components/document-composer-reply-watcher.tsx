import { useEffect } from "react";
import { useNavigate } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { useTranslation } from "@/i18n";

/**
 * Take down the processing marker the composer's sends raised in
 * `conversationId`, once none of them is left waiting on a reply. Sends still
 * pending keep the activity up.
 */
function clearProcessingWhenSettled(conversationId: string): void {
  if (
    useDocumentComposerReplyStore.getState().pendingReplies.has(conversationId)
  ) {
    return;
  }
  useConversationStore
    .getState()
    .removeProcessingConversationId(conversationId);
}

/**
 * Fires the document composer's "Assistant replied" toast once the daemon
 * reports a turn complete for a send `useDocumentComposerSubmit` flagged as
 * awaiting a reply (`document-composer-reply-store.ts`), and ends the wait
 * silently when that turn is cancelled or fails instead. A terminal stream
 * event answers every send running in its conversation, since one turn can
 * run a batch of them, and raises one toast for them all. An `error` naming
 * a message is the exception: it ends only the send carrying that nonce.
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

  // One SSE connection follows the active assistant, so a wait held across a
  // switch never sees its reply and would toast on an unrelated turn. The
  // active assistant can change on routes that mount no conversation view
  // (the standalone document route), where nothing else resets per-assistant
  // chat state.
  useEffect(() => {
    let ownerAssistantId =
      useResolvedAssistantsStore.getState().activeAssistantId;
    return useResolvedAssistantsStore.subscribe((state) => {
      const { activeAssistantId } = state;
      // No active assistant is a transient state during a reload, not a move
      // to a different one.
      if (
        activeAssistantId === null ||
        activeAssistantId === ownerAssistantId
      ) {
        return;
      }
      if (ownerAssistantId !== null) {
        const replyStore = useDocumentComposerReplyStore.getState();
        // The outgoing assistant's connection is detached, so no terminal
        // takes these markers down, and the incoming assistant's attention
        // cleanup passes over conversations its own list does not name.
        for (const conversationId of replyStore.pendingReplies.keys()) {
          useConversationStore
            .getState()
            .removeProcessingConversationId(conversationId);
        }
        replyStore.clearAwaitingReplies();
      }
      ownerAssistantId = activeAssistantId;
    });
  }, []);

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
      useDocumentComposerReplyStore
        .getState()
        .markReplyRunning(event.conversationId, event.clientMessageId);
      return;
    }

    // The queue ack, not the send's POST response, is what acknowledges a send
    // as queued: it rides the same stream as the terminals below, while the
    // response can return after the running turn has already handed off. A
    // requeue is that same ack after a rolled-back dequeue, so it re-flags.
    if (event.type === "message_queued" || event.type === "message_requeued") {
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued(event.conversationId, event.clientMessageId);
      return;
    }

    // The daemon took the send off the queue for a turn, so it is running and
    // the terminal that ends that turn is its reply.
    if (event.type === "message_dequeued") {
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
      useDocumentComposerReplyStore
        .getState()
        .stopAwaitingReply(conversationId, clientMessageId);
      clearProcessingWhenSettled(conversationId);
      return;
    }

    if (
      event.type !== "generation_handoff" &&
      event.type !== "generation_cancelled" &&
      event.type !== "error" &&
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
    // An `error` that names a message is that message's alone, a queued
    // member the daemon could not persist while the batch it was dequeued
    // with runs on, so only the send carrying that nonce ends. An `error`
    // naming no message is the turn's, and ends every send running in it.
    if (event.type === "error" && event.clientMessageId !== undefined) {
      const { clientMessageId } = event;
      const replyStore = useDocumentComposerReplyStore.getState();
      const pending = replyStore.pendingReplies.get(conversationId) ?? [];
      // A nonce naming none of these sends is another client's message, and
      // the sends listed here are still owed their own terminals.
      if (!pending.some((p) => p.clientMessageId === clientMessageId)) {
        return;
      }
      replyStore.stopAwaitingReply(conversationId, clientMessageId);
      clearProcessingWhenSettled(conversationId);
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
    if (settled === 0) {
      return;
    }
    clearProcessingWhenSettled(conversationId);
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
