import type { AssistantEvent } from "../api/index.js";
import type { QueuedMessage } from "../daemon/conversation-queue-manager.js";
import { linkMessage, storeReplyMessageId } from "../persistence/delivery-crud.js";
import {
  markDeliveryDelivered,
  markProcessed,
} from "../persistence/delivery-status.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { finalizeEventDelivery } from "./finalize-event-delivery.js";
import {
  shouldEmitTelegramTyping,
  startTelegramTypingHeartbeat,
} from "./routes/inbound-stages/telegram-typing.js";

const log = getLogger("queued-channel-followup");

export function linkQueuedChannelIngress(
  item: QueuedMessage,
  userMessageId: string,
): void {
  if (!item.channelDelivery) {
    return;
  }
  linkMessage(item.channelDelivery.eventId, userMessageId);
}

export function startQueuedTelegramTyping(
  items: QueuedMessage[],
): (() => void) | undefined {
  for (const item of items) {
    const delivery = item.channelDelivery;
    if (!delivery) {
      continue;
    }
    const callbackUrl = delivery.replyCallbackUrl;
    if (
      !callbackUrl ||
      !shouldEmitTelegramTyping(delivery.sourceChannel, callbackUrl)
    ) {
      continue;
    }
    return startTelegramTypingHeartbeat(
      callbackUrl,
      delivery.externalChatId,
      delivery.assistantId,
    );
  }
  return undefined;
}

export function captureReplyMessageId(
  onEvent: (msg: AssistantEvent) => void,
  replyMessageIdRef: { current: string | undefined },
): (msg: AssistantEvent) => void {
  return (msg: AssistantEvent) => {
    if (
      msg.type === "message_complete" &&
      (msg.source === undefined || msg.source === "main") &&
      typeof msg.messageId === "string"
    ) {
      replyMessageIdRef.current = msg.messageId;
    }
    onEvent(msg);
  };
}

export async function completeQueuedChannelFollowUps(params: {
  items: QueuedMessage[];
  conversationId: string;
  lastUserMessageId?: string;
  replyMessageId?: string;
}): Promise<void> {
  const deliveries = params.items
    .map((item) => item.channelDelivery)
    .filter((delivery): delivery is NonNullable<typeof delivery> =>
      Boolean(delivery),
    );
  if (deliveries.length === 0) {
    return;
  }

  for (const delivery of deliveries) {
    markProcessed(delivery.eventId);
    if (params.replyMessageId) {
      storeReplyMessageId(delivery.eventId, params.replyMessageId);
    }
  }

  const primary = deliveries.find((delivery) => delivery.replyCallbackUrl);
  if (!primary?.replyCallbackUrl || !params.lastUserMessageId) {
    return;
  }

  try {
    await finalizeEventDelivery({
      eventId: primary.eventId,
      conversationId: params.conversationId,
      externalChatId: primary.externalChatId,
      replyCallbackUrl: primary.replyCallbackUrl,
      assistantId: primary.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
      replyMessageId: params.replyMessageId,
      userMessageId: params.lastUserMessageId,
      slackReplySession: undefined,
    });
    for (const delivery of deliveries) {
      if (delivery.eventId !== primary.eventId) {
        markDeliveryDelivered(delivery.eventId);
      }
    }
  } catch (err) {
    log.error(
      {
        err,
        conversationId: params.conversationId,
        eventId: primary.eventId,
      },
      "Queued Telegram follow-up reply delivery failed",
    );
  }
}
