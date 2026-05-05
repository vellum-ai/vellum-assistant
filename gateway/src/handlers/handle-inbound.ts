import { existsSync } from "node:fs";
import type { GatewayConfig } from "../config.js";
import { ipcCallAssistant } from "../ipc/assistant-client.js";
import { resolveIpcSocketPath } from "../ipc/socket-path.js";
import { ContactStore } from "../db/contact-store.js";
import { getLogger } from "../logger.js";
import { canonicalizeInboundIdentity } from "../verification/identity.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import {
  forwardToRuntime,
  CircuitBreakerOpenError,
} from "../runtime/client.js";
import type { RuntimeInboundResponse } from "../runtime/client.js";
import type { GatewayInboundEvent } from "../types.js";
import { tryTextVerificationIntercept } from "../verification/text-verification.js";
import { upsertVerifiedContactChannel } from "../verification/contact-helpers.js";

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

    // ── Contact channel interaction tracking (dual-write) ──
    // Reads from the assistant DB (source of truth during migration),
    // writes to both assistant DB and gateway DB. Uses ipcCallAssistant
    // directly (resolves to undefined on failure, never throws) so
    // socket errors cannot leak as unhandled rejections in tests.
    if (!response.denied) {
      // Fire-and-forget: detach from current async context so pending
      // IPC socket operations cannot leak into test runners.
      void touchContactChannelStats(event, response.duplicate).catch(
        () => {},
      );
    }

    if (response.activatedContact) {
      const { sourceChannel, externalUserId, externalChatId, displayName } =
        response.activatedContact;
      void upsertVerifiedContactChannel({
        sourceChannel,
        externalUserId,
        externalChatId: externalChatId ?? externalUserId,
        displayName,
      }).catch(() => {});
    }

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

// ---------------------------------------------------------------------------
// Contact channel interaction tracking (dual-write helper)
// ---------------------------------------------------------------------------

interface DbProxyResult {
  rows?: Array<Record<string, unknown>>;
}

/**
 * Look up the contact channel in the assistant DB and dual-write
 * interaction stats to both the assistant and gateway databases.
 *
 * Uses ipcCallAssistant directly (resolves to undefined on failure)
 * so socket errors cannot surface as unhandled rejections.
 */
async function touchContactChannelStats(
  event: GatewayInboundEvent,
  duplicate: boolean,
): Promise<void> {
  // Skip if the assistant IPC socket is not available (e.g. in tests).
  const { path: socketPath } = resolveIpcSocketPath("assistant");
  if (!existsSync(socketPath)) return;

  const canonicalActorId =
    canonicalizeInboundIdentity(
      event.sourceChannel,
      event.actor.actorExternalId,
    ) ?? event.actor.actorExternalId;

  // Look up channel in assistant DB (source of truth), with
  // externalChatId fallback for legacy/imported contacts.
  let result = (await ipcCallAssistant("db_proxy", {
    sql: "SELECT id FROM contact_channels WHERE type = ? AND external_user_id = ? LIMIT 1",
    mode: "query",
    bind: [event.sourceChannel, canonicalActorId],
  })) as DbProxyResult | undefined;

  if (!result?.rows?.length) {
    result = (await ipcCallAssistant("db_proxy", {
      sql: "SELECT id FROM contact_channels WHERE type = ? AND external_chat_id = ? LIMIT 1",
      mode: "query",
      bind: [event.sourceChannel, event.message.conversationExternalId],
    })) as DbProxyResult | undefined;
  }

  if (!result?.rows?.length) return;

  const channelId = result.rows[0].id as string;
  const now = Date.now();

  // Assistant DB writes
  await ipcCallAssistant("db_proxy", {
    sql: "UPDATE contact_channels SET last_seen_at = ?, updated_at = ? WHERE id = ?",
    mode: "run",
    bind: [now, now, channelId],
  });
  if (!duplicate) {
    await ipcCallAssistant("db_proxy", {
      sql: "UPDATE contact_channels SET last_interaction = ?, interaction_count = interaction_count + 1, updated_at = ? WHERE id = ?",
      mode: "run",
      bind: [now, now, channelId],
    });
  }

  // Gateway DB writes
  const store = new ContactStore();
  store.touchChannelLastSeen(channelId);
  if (!duplicate) {
    store.touchContactInteraction(channelId);
  }
}
