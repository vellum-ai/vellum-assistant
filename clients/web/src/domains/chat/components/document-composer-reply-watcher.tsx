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
 * silently when that turn is cancelled or fails instead. Each terminal stream
 * event settles one send, oldest first, which is the order the daemon runs the
 * turns in.
 *
 * The queued flag on a pending send is this watcher's own: the daemon's queue
 * events set and clear it, which keeps it ordered against the terminals it has
 * to survive.
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

    // The queue ack, not the send's POST response, is what flags a send as
    // queued: it rides the same stream as the terminals below, while the
    // response can return after the running turn has already handed off. A
    // requeue is that same ack after a rolled-back dequeue, so it re-flags.
    if (event.type === "message_queued" || event.type === "message_requeued") {
      useDocumentComposerReplyStore
        .getState()
        .markReplyQueued(event.conversationId, event.clientMessageId);
      return;
    }

    // The runtime is starting the queued send, so the next terminal is its own
    // and there is nothing left ahead of it to absorb.
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
    // Each of these ends the turn that was running (`error` and
    // `conversation_error` are the two the chat stream handlers also treat as
    // turn-ending, `utils/stream-handlers/error-handlers.ts`), and the daemon
    // drains the conversation's queue after every one of them. So the turn
    // that ended is the oldest pending send's, unless that send is flagged
    // queued, in which case the turn ahead of it owns this terminal.
    const settled = useDocumentComposerReplyStore
      .getState()
      .settleOldestReply(conversationId);
    if (settled !== "answered") {
      return;
    }
    clearProcessingWhenSettled(conversationId);
    // The daemon emits a handoff in place of `message_complete` when the turn
    // finishes with more messages queued behind it, so the reply is done. The
    // three failure terminals answer the send with nothing to announce.
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
