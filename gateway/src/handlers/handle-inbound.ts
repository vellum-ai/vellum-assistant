import pino from "pino";
import type { GatewayConfig } from "../config.js";
import type { GatewayInboundEventV1 } from "../types.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import { forwardToRuntime } from "../runtime/client.js";
import type { RuntimeInboundResponse } from "../runtime/client.js";

const log = pino({ name: "gateway:handle-inbound" });

export type InboundResult = {
  forwarded: boolean;
  rejected: boolean;
  runtimeResponse?: RuntimeInboundResponse;
  rejectionReason?: string;
};

export async function handleInbound(
  config: GatewayConfig,
  event: Omit<GatewayInboundEventV1, "routing">,
): Promise<InboundResult> {
  const routing = resolveAssistant(
    config,
    event.message.externalChatId,
    event.sender.externalUserId,
  );

  if (isRejection(routing)) {
    log.info(
      { externalChatId: event.message.externalChatId, reason: routing.reason },
      "Inbound event rejected by routing",
    );
    return { forwarded: false, rejected: true, rejectionReason: routing.reason };
  }

  const displayName = event.sender.displayName || event.sender.username;

  try {
    const response = await forwardToRuntime(config, routing.assistantId, {
      sourceChannel: event.sourceChannel,
      externalChatId: event.message.externalChatId,
      externalMessageId: event.message.externalMessageId,
      content: event.message.content,
      senderName: displayName,
      senderExternalUserId: event.sender.externalUserId,
      senderUsername: event.sender.username,
      sourceMetadata: {
        updateId: event.source.updateId,
        messageId: event.source.messageId,
        chatType: event.source.chatType,
        languageCode: event.sender.languageCode,
        isBot: event.sender.isBot,
      },
    });

    log.info(
      {
        assistantId: routing.assistantId,
        routeSource: routing.routeSource,
        eventId: response.eventId,
        duplicate: response.duplicate,
        hasReply: !!response.assistantMessage,
      },
      "Inbound event forwarded to runtime",
    );

    return { forwarded: true, rejected: false, runtimeResponse: response };
  } catch (err) {
    log.error(
      { err, assistantId: routing.assistantId },
      "Failed to forward inbound event to runtime",
    );
    return { forwarded: false, rejected: false };
  }
}
