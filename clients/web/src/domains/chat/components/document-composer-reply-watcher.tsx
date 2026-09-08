import { useNavigate } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useConversationStore } from "@/stores/conversation-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { useTranslation } from "@/i18n";

/**
 * Fires the document composer's "Assistant replied" toast once the daemon
 * reports a turn complete for a conversation `useDocumentComposerSubmit`
 * flagged as awaiting a reply (`document-composer-reply-store.ts`).
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
    if (event.type !== "message_complete") {
      return;
    }
    // Auxiliary notifier injections (call transcripts, watch summaries) are
    // not a reply the document composer sent a message toward.
    if (event.source === "aux") {
      return;
    }
    const { conversationId } = event;
    if (!conversationId) {
      return;
    }
    const { awaitingReplyConversationIds, stopAwaitingReply } =
      useDocumentComposerReplyStore.getState();
    if (!awaitingReplyConversationIds.has(conversationId)) {
      return;
    }
    stopAwaitingReply(conversationId);
    useConversationStore
      .getState()
      .removeProcessingConversationId(conversationId);
    toast.success(t("documentComposer.assistantRepliedToast"), {
      action: {
        label: t("documentComposer.viewReply"),
        onClick: () => navigateToConversation(navigate, conversationId),
      },
    });
  });

  return null;
}
