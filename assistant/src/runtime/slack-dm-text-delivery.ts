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
  getFinalDeliveryResumeOptions: (
    messageId: string | undefined,
  ) => { startFromSegment: number; messageTs?: string } | undefined;
};

export function createSlackDmTextDeliveryController(params: {
  sourceChannel: ChannelId;
  chatType?: string;
  replyCallbackUrl?: string;
  chatId: string;
  assistantId?: string;
  deliveredTextResponseIndexes?: readonly number[];
  onTextResponseDelivered?: (
    responseIndex: number,
    reason: "before_tool" | "message_complete",
  ) => void;
}): SlackDmTextDeliveryController | undefined {
  const { replyCallbackUrl } = params;
  if (!shouldDeliverSlackDmTextResponses(params) || !replyCallbackUrl) {
    return undefined;
  }

  const deliveredTextResponseIndexes = new Set(
    params.deliveredTextResponseIndexes ?? [],
  );
  const messageIdToResponseIndexes = new Map<string, number[]>();
  const responseIndexToMessageTs = new Map<number, string>();
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

  const flushPendingText = (
    reason: "before_tool" | "message_complete",
  ): void => {
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
        let result: Awaited<ReturnType<typeof deliverChannelReply>>;
        try {
          result = await deliverChannelReply(replyCallbackUrl, {
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

        if (result.ts) {
          responseIndexToMessageTs.set(currentResponseIndex, result.ts);
        }
        deliveredTextResponseIndexes.add(currentResponseIndex);
        try {
          params.onTextResponseDelivered?.(currentResponseIndex, reason);
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
        flushPendingText("message_complete");
        if (typeof msg.messageId === "string") {
          associateCurrentMessageResponses(msg.messageId);
        }
        currentMessageResponseIndexes = [];
        return;
      }

      if (msg.type === "tool_use_start") {
        flushPendingText("before_tool");
      }
    },
    waitForPendingDeliveries: () => deliveryChain,
    getFinalDeliveryResumeOptions: (messageId) => {
      if (typeof messageId !== "string") {
        return undefined;
      }
      const responseIndexes = messageIdToResponseIndexes.get(messageId) ?? [];
      let deliveredPrefixCount = 0;
      for (const responseIndex of responseIndexes) {
        if (!deliveredTextResponseIndexes.has(responseIndex)) break;
        deliveredPrefixCount += 1;
      }
      if (deliveredPrefixCount === 0) return undefined;

      const firstLiveResponseIndex = responseIndexes[0];
      const allTextResponsesDelivered =
        responseIndexes.length > 0 &&
        responseIndexes.every((responseIndex) =>
          deliveredTextResponseIndexes.has(responseIndex),
        );
      const messageTs =
        allTextResponsesDelivered && firstLiveResponseIndex !== undefined
          ? responseIndexToMessageTs.get(firstLiveResponseIndex)
          : undefined;
      return {
        startFromSegment: deliveredPrefixCount,
        ...(messageTs ? { messageTs } : {}),
      };
    },
  };
}
