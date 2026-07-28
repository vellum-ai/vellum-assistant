import { updateDeliveredSegmentCount } from "../persistence/delivery-channels.js";
import {
  markDeliveryDelivered,
  recordDeliveryFailure,
} from "../persistence/delivery-status.js";
import { deliverReplyViaCallback } from "./channel-reply-delivery.js";
import type { SlackReplySession } from "./slack-reply-session.js";

/**
 * Owns the complete delivery-after-processing sequence for a channel
 * inbound event: finalizes any live Slack stream, persists the segment
 * baseline so delivery-only retries resume correctly, delivers remaining
 * content + attachments, and transitions the event to its terminal delivery
 * state.
 *
 * Both the primary dispatch path and the processing-retry path call this
 * function. The delivery-only retry path does NOT use this function — it
 * reads the already-persisted segment count and calls
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
  slackReplySession: SlackReplySession | undefined;
  /**
   * `ts` of a Slack message streamed on a previous, failed attempt. A retry
   * has no live stream of its own, so it edits this message in place rather
   * than posting a duplicate reply.
   */
  priorStreamMessageTs?: string;
}): Promise<void> {
  const {
    eventId,
    conversationId,
    externalChatId,
    replyCallbackUrl,
    assistantId,
    replyMessageId,
    userMessageId,
    slackReplySession,
    priorStreamMessageTs,
  } = params;

  const reconciliation = await slackReplySession?.finish();

  // A streamed reply already delivered its text live into a single message;
  // durable delivery skips that text, reconciles `slackMeta.channelTs` to the
  // stream `ts`, and posts only attachments. A retry reuses the prior attempt's
  // streamed message, re-delivering the full reply with its first segment
  // editing that message. A plain turn delivers the full reply from segment 0.
  const startFromSegment =
    reconciliation?.mode === "streamed"
      ? reconciliation.deliveredSegmentCount
      : 0;
  const streamMessageTs =
    reconciliation?.mode === "streamed"
      ? reconciliation.messageTs
      : priorStreamMessageTs;

  try {
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
