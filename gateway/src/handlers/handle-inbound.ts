import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import {
  forwardToRuntime,
  CircuitBreakerOpenError,
} from "../runtime/client.js";
import type { RuntimeInboundResponse } from "../runtime/client.js";
import type { GatewayInboundEvent } from "../types.js";
import { tryTextVerificationIntercept } from "../verification/text-verification.js";

const log = getLogger("handle-inbound");

export type InboundResult = {
  forwarded: boolean;
  rejected: boolean;
  verificationIntercepted?: boolean;
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
  /** Extra fields merged into sourceMetadata (e.g. commandIntent). */
  sourceMetadata?: Record<string, unknown>;
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
  event: GatewayInboundEvent,
  options?: HandleInboundOptions,
): Promise<InboundResult> {
  const routing =
    options?.routingOverride ??
    resolveAssistant(
      config,
      event.message.conversationExternalId,
      event.actor.actorExternalId,
    );

  if (isRejection(routing)) {
    log.info(
      {
        conversationExternalId: event.message.conversationExternalId,
        reason: routing.reason,
      },
      "Inbound event rejected by routing",
    );
    return {
      forwarded: false,
      rejected: true,
      rejectionReason: routing.reason,
    };
  }

  const displayName = event.actor.displayName || event.actor.username;

  // ── Text verification intercept ──
  // Must run before forwardToRuntime so the assistant never sees
  // verification code messages. Both success and failure short-circuit.
  const verificationResult = await tryTextVerificationIntercept({
    sourceChannel: event.sourceChannel,
    messageContent: event.message.content,
    actorExternalUserId: event.actor.actorExternalId,
    actorChatId: event.message.conversationExternalId,
    actorDisplayName: event.actor.displayName,
    actorUsername: event.actor.username,
    replyCallbackUrl: options?.replyCallbackUrl,
    assistantId: routing.assistantId,
  });

  if (verificationResult.intercepted) {
    log.info(
      {
        sourceChannel: event.sourceChannel,
        outcome: verificationResult.outcome,
        trustClass: verificationResult.trustClass,
      },
      "Text verification intercepted — not forwarding to runtime",
    );
    return {
      forwarded: false,
      rejected: false,
      verificationIntercepted: true,
    };
  }

  const transportHints = normalizeTransportHints(
    options?.transportMetadata?.hints,
  );
  const transportUxBrief = options?.transportMetadata?.uxBrief?.trim();

  try {
    const response = await forwardToRuntime(
      config,
      {
        sourceChannel: event.sourceChannel,
        interface: event.sourceChannel,
        conversationExternalId: event.message.conversationExternalId,
        externalMessageId: event.message.externalMessageId,
        content: event.message.content,
        ...(event.message.isEdit ? { isEdit: true } : {}),
        ...(event.message.callbackQueryId
          ? { callbackQueryId: event.message.callbackQueryId }
          : {}),
        ...(event.message.callbackData
          ? { callbackData: event.message.callbackData }
          : {}),
        actorDisplayName: displayName,
        actorExternalId: event.actor.actorExternalId,
        actorUsername: event.actor.username,
        sourceMetadata: {
          updateId: event.source.updateId,
          messageId: event.source.messageId,
          chatType: event.source.chatType,
          ...(event.source.threadId ? { threadId: event.source.threadId } : {}),
          languageCode: event.actor.languageCode,
          isBot: event.actor.isBot,
          ...(transportHints.length > 0 ? { hints: transportHints } : {}),
          ...(transportUxBrief ? { uxBrief: transportUxBrief } : {}),
          ...(options?.sourceMetadata ?? {}),
        },
        ...(options?.attachmentIds?.length
          ? { attachmentIds: options.attachmentIds }
          : {}),
        ...(options?.replyCallbackUrl
          ? { replyCallbackUrl: options.replyCallbackUrl }
          : {}),
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
    // Let CircuitBreakerOpenError propagate so webhook handlers can
    // return 503 + Retry-After instead of 500, which would cause
    // Telegram (and similar transports) to retry immediately.
    if (err instanceof CircuitBreakerOpenError) throw err;

    log.error(
      { err, assistantId: routing.assistantId },
      "Failed to forward inbound event to runtime",
    );
    return { forwarded: false, rejected: false };
  }
}
