import { shouldSuppressGenericChatErrorNotice } from "@/domains/chat/utils/error-classification";
import { ERROR_MESSAGES } from "@/domains/chat/utils/chat";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { messageMatchesKey } from "@/domains/chat/utils/message-identity";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { isMessageScopedError } from "@/domains/chat/utils/message-scoped-error";
import type { StreamHandlerContext } from "@/domains/chat/utils/stream-handlers/types";
import { patchConversation } from "@/utils/conversation-cache";
import { removeQueuedMessage } from "@/domains/chat/utils/stream-updaters/shared";
import { useComposerStore } from "@/domains/chat/composer-store";
import type {
  ConversationErrorEvent,
  ConversationNoticeEvent,
  ErrorEvent,
  MessageFailedEvent,
} from "@vellumai/assistant-api";

type ErrorDetailEvent = ErrorEvent | MessageFailedEvent;

function resolveErrorDetail(event: ErrorDetailEvent): string {
  return (
    (event.code && ERROR_MESSAGES[event.code]) ||
    event.message ||
    "Something went wrong."
  );
}

/**
 * Scoped errors are accepted for compatibility with assistants that emitted
 * a message failure before `message_failed` had its own discriminator.
 * Everything else is the turn's terminal error.
 */
export function handleStreamError(
  event: ErrorEvent,
  ctx: StreamHandlerContext,
): void {
  const { clientMessageId } = event;
  if (isMessageScopedError(event)) {
    handleMessageScopedError(event, clientMessageId, ctx);
    return;
  }
  const convId = ctx.streamContext?.conversationId;

  // A full queue refusing a send the daemon had already accepted. It is a
  // delivery failure for one message, not a turn ending: the conversation may
  // still be running the turn this send tried to interrupt, so this must not
  // clear `isProcessing` or end the turn the way a generation error does.
  // Recovery matches the request-path failure in `use-send-message`: drop the
  // optimistic row and put its text back in the composer, so the user has what
  // they typed and can send it again.
  if (event.code === "QUEUE_FULL" && event.requestId) {
    const messageId = ctx.popRequestIdMapping(event.requestId);
    if (messageId) {
      ctx.setOptimisticSends((prev) => {
        const failed = prev.find((message) =>
          messageMatchesKey(message, messageId),
        );
        const text = failed?.textSegments?.join("");
        if (text && ctx.assistantId && convId) {
          useComposerStore
            .getState()
            .restoreFailedDraft(ctx.assistantId, convId, text);
        }
        return removeQueuedMessage(prev, messageId);
      });
    }
    ctx.setError({
      message: event.message || "Something went wrong.",
      code: event.code,
      ...(event.errorCategory ? { errorCategory: event.errorCategory } : {}),
    });
    return;
  }

  if (convId) {
    // Mirrors the cache patch in `handleMessageComplete`: terminal
    // errors must also clear the cached `isProcessing: true` snapshot
    // so the OR derivation in chat-route-content can't latch.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  ctx.endTurn({ conversationId: convId, reason: "error" });
  ctx.setError({
    message: resolveErrorDetail(event),
    code: event.code,
    errorCategory: event.errorCategory,
  });
  ctx.cancelAndClearStream();
}

export function handleMessageFailed(
  event: MessageFailedEvent,
  ctx: StreamHandlerContext,
): void {
  handleMessageScopedError(event, event.clientMessageId, ctx);
}

/**
 * The one message's failure: no `endTurn`, no `isProcessing` patch, no stream
 * cancel, because the turn the batch is running is still generating a reply.
 * The rollback needs the nonce to know which optimistic row failed; without one
 * the failure is still the message's, it just has no local row to name.
 *
 * This is the whole answer for the conversation on screen, whether or not a
 * row survives to name the message: the nonce also names the copy
 * `useSendMessage` kept when the daemon took the send onto its queue, and
 * `QueuedSendRecoveryWatcher` leaves that copy here rather than answer for a
 * conversation this handler is already looking at.
 */
function handleMessageScopedError(
  event: ErrorDetailEvent,
  clientMessageId: string | undefined,
  ctx: StreamHandlerContext,
): void {
  const detail = resolveErrorDetail(event);
  const failedSend = clientMessageId
    ? useChatSessionStore
        .getState()
        .optimisticSends.find((m) => messageMatchesKey(m, clientMessageId))
    : undefined;

  // No row names the message, but the nonce still can: a send the daemon took
  // onto its queue is kept by `useSendMessage` until the daemon speaks for it,
  // and that copy outlives the row, which goes with the transcript on a
  // switch and can be cleared by a resync. It carries the conversation it was
  // composed for, so the message goes back to that thread whatever this stream
  // is showing now.
  if (clientMessageId && !failedSend) {
    const composer = useComposerStore.getState();
    const recoveryWasClaimed =
      composer.claimedQueuedSendIds.has(clientMessageId);
    const held = composer.takeQueuedSend(clientMessageId);
    if (held) {
      if (!recoveryWasClaimed) {
        composer.dropFailedSendByClientMessageId(clientMessageId);
        composer.stashFailedSend(held.assistantId, held.conversationId, {
          content: held.content,
          attachments: held.attachments,
        });
      }
      ctx.setError({
        message: detail,
        code: event.code,
        errorCategory: event.errorCategory,
        displayAs: "modal",
        conversationId: held.conversationId,
      });
      return;
    }
  }

  if (!clientMessageId || !failedSend) {
    // A send that carries no nonce, another client's send, or one this tab
    // holds neither a row nor a queued copy for. There is nothing local to
    // roll back, so the failure goes to the non-terminal channel
    // `handleConversationNoticeEvent` uses: a warning banner in the composer
    // area that leaves the turn and the stream alone.
    ctx.setNotice({
      message: detail,
      code: event.code,
      errorCategory: event.errorCategory,
    });
    return;
  }

  // The daemon never persisted this message, so the row that stands for it
  // comes out as soon as the failure is known, and the row is what the message
  // is read from: it is the fuller copy, carrying every edit the composer made
  // to the text on its way out. The message is handed to the store here, at
  // the moment the row is taken off screen,
  // rather than when the modal is acknowledged: one dequeued batch can fail
  // two of its members, and both errors arrive before the user has answered
  // the first modal. The store holds one message per conversation and joins a
  // second onto it, so each failure keeps its text and attachments whatever
  // the modal is showing. The conversation names where the message goes back
  // to, so it reaches that thread's composer rather than whichever one is on
  // screen.
  //
  // What is left for the modal is the telling: `displayAs: "modal"` is the
  // rejected-POST affordance from `use-send-message`, and this one carries no
  // message of its own to give back. It sets state only, so the reply
  // streaming behind it is untouched.
  ctx.setOptimisticSends((prev) =>
    prev.filter((m) => !messageMatchesKey(m, clientMessageId)),
  );
  if (event.conversationId && ctx.assistantId) {
    useComposerStore
      .getState()
      .stashFailedSend(ctx.assistantId, event.conversationId, {
        content: messagePlainText(failedSend),
        attachments: failedSend.attachments ?? [],
      });
  }
  // The row said everything the queued copy of this send would have, so the
  // copy is spent.
  useComposerStore.getState().dropQueuedSend(clientMessageId);
  ctx.setError({
    message: detail,
    code: event.code,
    errorCategory: event.errorCategory,
    displayAs: "modal",
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
  });
}

export function handleConversationErrorEvent(
  event: ConversationErrorEvent,
  ctx: StreamHandlerContext,
): void {
  const isBannerError = shouldSuppressGenericChatErrorNotice(event);

  // `ConversationErrorEvent` carries `conversationId` as a required
  // field; prefer it over `streamContext?.conversationId` (which is
  // a mirror that may be cleared by a stream teardown racing the
  // error event) — same fallback shape as the other terminal handlers.
  const convId = event.conversationId ?? ctx.streamContext?.conversationId;
  if (convId) {
    // See `handleStreamError` for the stale-snapshot rationale.
    patchConversation(ctx.queryClient, ctx.assistantId, convId, {
      isProcessing: false,
    });
  }
  ctx.endTurn({ conversationId: convId, reason: "error" });

  ctx.setError({
    message: event.userMessage,
    code: event.code,
    errorCategory: event.errorCategory,
  });

  if (!isBannerError) {
    ctx.cancelAndClearStream();
  }
}

export function handleConversationNoticeEvent(
  event: ConversationNoticeEvent,
  ctx: StreamHandlerContext,
): void {
  ctx.setNotice({
    message: event.userMessage,
    code: event.code,
    errorCategory: event.errorCategory,
  });
}
