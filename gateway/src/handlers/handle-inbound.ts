import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import { forwardToRuntime } from "../runtime/client.js";
import type { RuntimeInboundResponse } from "../runtime/client.js";
import type { GatewayInboundEventV1 } from "../types.js";

const log = getLogger("handle-inbound");

export type InboundResult = {
  forwarded: boolean;
  rejected: boolean;
  runtimeResponse?: RuntimeInboundResponse;
  rejectionReason?: string;
};

export type TransportMetadataOverrides = {
  hints?: string[];
  uxBrief?: string;
};

export type HandleInboundOptions = {
  attachmentIds?: string[];
  transportMetadata?: TransportMetadataOverrides;
  replyCallbackUrl?: string;
  traceId?: string;
  /** When provided, skip resolveAssistant() and use this pre-resolved route. */
  routingOverride?: RouteResult;
};

function normalizeTransportHints(hints: string[] | undefined): string[] {
  if (!hints || hints.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of hints) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export async function handleInbound(
  config: GatewayConfig,
  event: Omit<GatewayInboundEventV1, "routing">,
  options?: HandleInboundOptions,
): Promise<InboundResult> {
  const routing = options?.routingOverride ?? resolveAssistant(
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
  const transportHints = normalizeTransportHints(options?.transportMetadata?.hints);
  const transportUxBrief = options?.transportMetadata?.uxBrief?.trim();

  try {
    const response = await forwardToRuntime(
      config,
      routing.assistantId,
      {
        sourceChannel: event.sourceChannel,
        externalChatId: event.message.externalChatId,
        externalMessageId: event.message.externalMessageId,
        content: event.message.content,
        ...(event.message.isEdit ? { isEdit: true } : {}),
        ...(event.message.callbackQueryId ? { callbackQueryId: event.message.callbackQueryId } : {}),
        ...(event.message.callbackData ? { callbackData: event.message.callbackData } : {}),
        senderName: displayName,
        senderExternalUserId: event.sender.externalUserId,
        senderUsername: event.sender.username,
        sourceMetadata: {
          updateId: event.source.updateId,
          messageId: event.source.messageId,
          chatType: event.source.chatType,
          languageCode: event.sender.languageCode,
          isBot: event.sender.isBot,
          ...(transportHints.length > 0 ? { hints: transportHints } : {}),
          ...(transportUxBrief ? { uxBrief: transportUxBrief } : {}),
        },
        ...(options?.attachmentIds?.length ? { attachmentIds: options.attachmentIds } : {}),
        ...(options?.replyCallbackUrl ? { replyCallbackUrl: options.replyCallbackUrl } : {}),
      },
      { traceId: options?.traceId },
    );

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
