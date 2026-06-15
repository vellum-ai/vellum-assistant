import { updateDeliveredSegmentCount } from "../memory/delivery-channels.js";
import {
  markDeliveryDelivered,
  recordDeliveryFailure,
} from "../memory/delivery-status.js";
import { deliverReplyViaCallback } from "./channel-reply-delivery.js";
import type { SlackDmTextDeliveryController } from "./slack-dm-text-delivery.js";

/**
 * Owns the complete delivery-after-processing sequence for a channel
 * inbound event: waits for in-flight live Slack DM deliveries to settle,
 * persists the segment baseline so delivery-only retries resume correctly,
 * delivers remaining content + attachments, and transitions the event to
 * its terminal delivery state.
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
  slackDmTextDelivery: SlackDmTextDeliveryController | undefined;
}): Promise<void> {
  const {
    eventId,
    conversationId,
    externalChatId,
    replyCallbackUrl,
    assistantId,
    replyMessageId,
    userMessageId,
    slackDmTextDelivery,
  } = params;

  if (slackDmTextDelivery) {
    await slackDmTextDelivery.waitForPendingDeliveries();
  }

  const resumeOptions =
    slackDmTextDelivery?.getFinalDeliveryResumeOptions(replyMessageId);
  const startFromSegment = resumeOptions?.startFromSegment ?? 0;
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
        ...(resumeOptions?.messageTs
          ? { messageTs: resumeOptions.messageTs }
          : {}),
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
