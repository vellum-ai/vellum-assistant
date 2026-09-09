import { useNavigate } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useConversationStore } from "@/stores/conversation-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { useTranslation } from "@/i18n";

/**
 * End the wait on `conversationId`, reporting whether one was in flight.
 * Clears the processing marker the send raised alongside it.
 */
function stopAwaitingReply(conversationId: string): boolean {
  const state = useDocumentComposerReplyStore.getState();
  if (!state.awaitingReplyConversationIds.has(conversationId)) {
    return false;
  }
  state.stopAwaitingReply(conversationId);
  useConversationStore
    .getState()
    .removeProcessingConversationId(conversationId);
  return true;
}

/**
 * Fires the document composer's "Assistant replied" toast once the daemon
 * reports a turn complete for a conversation `useDocumentComposerSubmit`
 * flagged as awaiting a reply (`document-composer-reply-store.ts`), and ends
 * the wait silently when that turn is cancelled or fails instead.
 *
 * Mounted once in `RootLayout`, above every document host's null guard, so
 * this subscription survives closing the document (`MobileDocumentOverlay`
 * returning `null`) or navigating off the standalone document route while a
 * reply is still in flight. Neither host stays mounted for the life of the
 * chat session, so the watcher cannot live inside either one.
 */
export function DocumentComposerReplyWatcher() {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;

    // A turn can end without a reply: cancelled, or failed terminally. The
    // daemon emits no `message_complete` after any of these, so the wait ends
    // here rather than latching until an unrelated turn completes and toasts
    // in its place. `error` and `conversation_error` are the two the chat
    // stream handlers also treat as turn-ending
    // (`utils/stream-handlers/error-handlers.ts`).
    if (
      event.type === "generation_cancelled" ||
      event.type === "error" ||
      event.type === "conversation_error"
    ) {
      const { conversationId } = event;
      if (conversationId) {
        stopAwaitingReply(conversationId);
      }
      return;
    }

    // `generation_handoff` is not terminal here: the daemon emits it when a
    // finished turn hands off to the next message queued in the same
    // conversation, so the reply this composer sent toward has yet to land.
    if (event.type !== "message_complete") {
      return;
    }
    // Auxiliary notifier injections (call transcripts, watch summaries) are
    // not a reply the document composer sent a message toward.
    if (event.source === "aux") {
      return;
    }
    const { conversationId } = event;
    if (!conversationId || !stopAwaitingReply(conversationId)) {
      return;
    }
    toast.success(t("documentComposer.assistantRepliedToast"), {
      action: {
        label: t("documentComposer.viewReply"),
        onClick: () => navigateToConversation(navigate, conversationId),
      },
    });
  });

  return null;
}
