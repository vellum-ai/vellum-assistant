import { settleChannelStream } from "../messaging/providers/index.js";
import { updateDeliveredSegmentCount } from "../persistence/delivery-channels.js";
import type { StreamedReply } from "../persistence/delivery-crud.js";
import {
  markDeliveryDelivered,
  recordDeliveryFailure,
} from "../persistence/delivery-status.js";
import { getLogger } from "../util/logger.js";
import { deliverReplyViaCallback } from "./channel-reply-delivery.js";
import type { ChannelReplySession } from "./channel-reply-session.js";

const log = getLogger("finalize-event-delivery");

/**
 * The message a retry should finish in place, after ending the stream a
 * previous attempt left open.
 *
 * A process that dies mid-turn never stops its stream, and a channel may refuse
 * to edit a message that is still streaming (Slack's `chat.update` returns
 * `streaming_state_conflict`), so the stream is settled before anything touches
 * the message. Settling one that already ended succeeds, so a later retry can
 * repeat it.
 *
 * A stream recorded as holding reply text is finished in place, and one that
 * cannot be settled throws rather than editing a message the channel would
 * refuse. The attempt then fails like any other delivery error: a transient
 * failure is retried by the sweep, and an outright refusal is dead-lettered. A stream that only
 * held a plan is settled on a best-effort basis and never returned: the plan
 * card stays as it was and the reply is posted beneath it, even when the card
 * could not be settled, because the reply is owed either way.
 *
 * One window stays open. A crash after the channel accepts the first reply text
 * but before its role is recorded reads as a plan, so the reply is posted beside
 * a message already showing part of it. Slack documents no idempotency key for
 * posts, so that window repeats the reply rather than risk overwriting a plan
 * card.
 */
export async function reconcilePriorStream(
  replyCallbackUrl: string,
  externalChatId: string,
  priorStream: StreamedReply | undefined,
): Promise<string | undefined> {
  if (!priorStream) {
    return undefined;
  }
  const holdsReply = priorStream.role !== "progress";
  try {
    const result = await settleChannelStream(
      replyCallbackUrl,
      externalChatId,
      priorStream.messageTs,
    );
    if (result && !result.ok) {
      throw new Error("The channel did not settle the prior stream");
    }
  } catch (err) {
    if (holdsReply) {
      throw err;
    }
    log.warn(
      { err, chatId: externalChatId },
      "Could not settle a plan-only stream; posting the reply beneath it",
    );
  }
  return holdsReply ? priorStream.messageTs : undefined;
}

/**
 * Owns the complete delivery-after-processing sequence for a channel
 * inbound event: finalizes any live Slack stream, persists the segment
 * baseline so delivery-only retries resume correctly, delivers remaining
 * content + attachments, and transitions the event to its terminal delivery
 * state.
 *
 * Both the primary dispatch path and the processing-retry path call this
 * function. The delivery-only retry path does NOT use this function: it reads
 * the already-persisted segment count and calls `reconcilePriorStream` and
 * `deliverReplyViaCallback` directly.
 */
export async function finalizeEventDelivery(params: {
  eventId: string;
  conversationId: string;
  externalChatId: string;
  replyCallbackUrl: string;
  assistantId: string | undefined;
  replyMessageId: string | undefined;
  userMessageId: string | undefined;
  replySession: ChannelReplySession | undefined;
  /**
   * The streamed message a previous, failed attempt recorded. A retry has no
   * live stream of its own, so it settles that stream, then finishes the
   * message in place when it held reply text or posts beneath it when it only
   * held a plan. See {@link reconcilePriorStream}.
   */
  priorStream?: StreamedReply;
}): Promise<void> {
  const {
    eventId,
    conversationId,
    externalChatId,
    replyCallbackUrl,
    assistantId,
    replyMessageId,
    userMessageId,
    replySession,
    priorStream,
  } = params;

  const reconciliation = await replySession?.finish();

  // A streamed reply already delivered its text live into a single message;
  // durable delivery skips that text, reconciles `slackMeta.channelTs` to the
  // stream `ts`, and posts only attachments. A retry settles the prior
  // attempt's stream and, when it held reply text, re-delivers the full reply
  // with its first segment editing that message. A plain turn delivers the
  // full reply from segment 0.
  const startFromSegment =
    reconciliation?.mode === "streamed"
      ? reconciliation.deliveredSegmentCount
      : 0;

  try {
    const streamMessageTs =
      reconciliation?.mode === "streamed"
        ? reconciliation.messageTs
        : await reconcilePriorStream(
            replyCallbackUrl,
            externalChatId,
            priorStream,
          );
    updateDeliveredSegmentCount(eventId, startFromSegment);
    await deliverReplyViaCallback(
      conversationId,
      externalChatId,
      replyCallbackUrl,
      assistantId,
      {
        messageId: replyMessageId,
        sinceMessageId: userMessageId,
        startFromSegment,
        ...(streamMessageTs ? { messageTs: streamMessageTs } : {}),
        onSegmentDelivered: (count) =>
          updateDeliveredSegmentCount(eventId, count),
      },
    );
    markDeliveryDelivered(eventId);
  } catch (err) {
    recordDeliveryFailure(eventId, err);
    throw err;
  }
}
