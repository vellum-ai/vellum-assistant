import type { ChannelId } from "../channels/types.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getLogger } from "../util/logger.js";
import { deliverChannelReply } from "./gateway-client.js";

const log = getLogger("runtime-http");

const NO_RESPONSE_INLINE_RE = /<no_response\s*\/?>/gi;

export function isSlackDeliveryCallbackUrl(replyCallbackUrl?: string): boolean {
  if (!replyCallbackUrl) return false;
  try {
    return new URL(replyCallbackUrl).pathname.endsWith("/deliver/slack");
  } catch {
    return replyCallbackUrl.endsWith("/deliver/slack");
  }
}

export function shouldDeliverSlackDmTextResponses(params: {
  sourceChannel: ChannelId;
  chatType?: string;
  replyCallbackUrl?: string;
}): boolean {
  return (
    params.sourceChannel === "slack" &&
    params.chatType === "im" &&
    isSlackDeliveryCallbackUrl(params.replyCallbackUrl)
  );
}

export type SlackDmTextDeliveryController = {
  observeEvent: (msg: ServerMessage) => void;
  waitForPendingDeliveries: () => Promise<void>;
  wasMessageDeliveredLive: (messageId: string | undefined) => boolean;
};

export function createSlackDmTextDeliveryController(params: {
  sourceChannel: ChannelId;
  chatType?: string;
  replyCallbackUrl?: string;
  chatId: string;
  assistantId?: string;
  deliveredTextResponseIndexes?: readonly number[];
  onTextResponseDelivered?: (responseIndex: number) => void;
}): SlackDmTextDeliveryController | undefined {
  const { replyCallbackUrl } = params;
  if (!shouldDeliverSlackDmTextResponses(params) || !replyCallbackUrl) {
    return undefined;
  }

  const deliveredTextResponseIndexes = new Set(
    params.deliveredTextResponseIndexes ?? [],
  );
  const messageIdToResponseIndexes = new Map<string, number[]>();
  const messagesWithUndeliveredText = new Set<string>();
  let textResponseIndex = 0;
  let pendingText = "";
  let currentMessageResponseIndexes: number[] = [];
  let deliveryChain = Promise.resolve();

  const associateCurrentMessageResponses = (
    messageId: string | undefined,
  ): void => {
    if (!messageId || currentMessageResponseIndexes.length === 0) return;
    const responseIndexes = messageIdToResponseIndexes.get(messageId) ?? [];
    for (const responseIndex of currentMessageResponseIndexes) {
      if (!responseIndexes.includes(responseIndex)) {
        responseIndexes.push(responseIndex);
      }
    }
    messageIdToResponseIndexes.set(messageId, responseIndexes);
    currentMessageResponseIndexes = [];
  };

  const flushPendingText = (): void => {
    const text = pendingText;
    pendingText = "";

    const deliverableText = text.replace(NO_RESPONSE_INLINE_RE, "").trim();
    if (deliverableText.length === 0) return;

    textResponseIndex += 1;
    const currentResponseIndex = textResponseIndex;
    currentMessageResponseIndexes.push(currentResponseIndex);
    if (deliveredTextResponseIndexes.has(currentResponseIndex)) return;

    deliveryChain = deliveryChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: params.chatId,
            text: deliverableText,
            assistantId: params.assistantId,
            useBlocks: true,
          });
        } catch (err) {
          log.warn(
            { err, chatId: params.chatId },
            "Failed to deliver intermediate Slack DM assistant text",
          );
          return;
        }

        deliveredTextResponseIndexes.add(currentResponseIndex);
        try {
          params.onTextResponseDelivered?.(currentResponseIndex);
        } catch (err) {
          log.warn(
            { err, chatId: params.chatId, responseIndex: currentResponseIndex },
            "Failed to persist intermediate Slack DM assistant text progress",
          );
        }
      });
  };

  return {
    observeEvent(msg) {
      if (msg.type === "assistant_text_delta") {
        pendingText += msg.text;
        return;
      }

      if (msg.type === "message_complete") {
        if (typeof msg.messageId === "string") {
          associateCurrentMessageResponses(msg.messageId);
          if (
            pendingText.replace(NO_RESPONSE_INLINE_RE, "").trim().length > 0
          ) {
            messagesWithUndeliveredText.add(msg.messageId);
          }
        }
        pendingText = "";
        currentMessageResponseIndexes = [];
        return;
      }

      if (msg.type === "tool_use_start") {
        flushPendingText();
      }
    },
    waitForPendingDeliveries: () => deliveryChain,
    wasMessageDeliveredLive: (messageId) => {
      if (
        typeof messageId !== "string" ||
        messagesWithUndeliveredText.has(messageId)
      ) {
        return false;
      }
      const responseIndexes = messageIdToResponseIndexes.get(messageId) ?? [];
      return (
        responseIndexes.length > 0 &&
        responseIndexes.every((responseIndex) =>
          deliveredTextResponseIndexes.has(responseIndex),
        )
      );
    },
  };
}
