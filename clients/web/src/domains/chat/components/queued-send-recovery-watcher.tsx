import { toast } from "@vellumai/design-library/components/toast";

import { useComposerStore } from "@/domains/chat/composer-store";
import { isMessageScopedError } from "@/domains/chat/utils/message-scoped-error";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/i18n";

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

  useBusSubscription("sse.event", (envelope) => {
    const event = envelope.message;

    // The echo is the daemon speaking for the message: it is persisted, and
    // the client copy has nothing left to answer for.
    if (event.type === "user_message_echo") {
      const { clientMessageId } = event;
      if (clientMessageId === undefined) {
        return;
      }
      useComposerStore.getState().dropQueuedSend(clientMessageId);
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

    if (event.type !== "error" || !isMessageScopedError(event)) {
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
    composer.takeQueuedSend(clientMessageId);
    composer.stashFailedSend(held.conversationId, {
      content: held.content,
      attachments: held.attachments,
    });
    toast.error(t("queuedSendRecovery.heldForConversation"));
  });

  return null;
}
