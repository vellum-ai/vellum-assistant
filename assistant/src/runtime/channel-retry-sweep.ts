/**
 * Periodic retry sweep for failed channel inbound events.
 */

import {
  type ChannelId,
  isChannelId,
  parseChannelId,
  parseInterfaceId,
} from "../channels/types.js";
import { isConversationBusyError } from "../daemon/conversation-messaging.js";
import { findConversation } from "../daemon/conversation-registry.js";
import { getDiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import { classifyDiskPressureTurnPolicy } from "../daemon/disk-pressure-policy.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { updateDeliveredSegmentCount } from "../persistence/delivery-channels.js";
import {
  clearPayload,
  linkMessage,
  storeReplyMessageId,
} from "../persistence/delivery-crud.js";
import {
  deferRetryUntilIdle,
  getRetryableDeliveryEvents,
  getRetryableEvents,
  isDeduplicatedDeliveryOwnedBySibling,
  markDeliveryDelivered,
  markProcessed,
  markRetryableFailure,
  recordDeliveryFailure,
  recordProcessingFailure,
} from "../persistence/delivery-status.js";
import { getLogger } from "../util/logger.js";
import {
  deliverReplyViaCallback,
  findAssistantReplyMessageIdForTurn,
} from "./channel-reply-delivery.js";
import { finalizeEventDelivery } from "./finalize-event-delivery.js";
import { deliverChannelReply } from "./gateway-client.js";
import type {
  MessageProcessor,
  SlackInboundMessageMetadata,
} from "./http-types.js";
import { prepareChannelInboundContent } from "./routes/inbound-stages/inbound-content-prep.js";
import { resolveRoutingStateFromRuntime } from "./trust-context-resolver.js";

const log = getLogger("runtime-http");
const DISK_PRESSURE_REMOTE_BLOCK_REPLY =
  "Storage is critically low, so remote messages are ignored until the guardian frees enough space. Please try again later.";

function parseTrustRuntimeContext(value: unknown): TrustContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const trustClass = raw.trustClass;
  if (
    trustClass !== "guardian" &&
    trustClass !== "trusted_contact" &&
    trustClass !== "unverified_contact" &&
    trustClass !== "unknown"
  ) {
    return undefined;
  }
  const rawSourceChannel =
    typeof raw.sourceChannel === "string" && raw.sourceChannel.trim().length > 0
      ? raw.sourceChannel
      : undefined;
  if (!rawSourceChannel || !isChannelId(rawSourceChannel)) {
    return undefined;
  }
  const sourceChannel = rawSourceChannel;
  return {
    sourceChannel,
    trustClass,
    guardianChatId:
      typeof raw.guardianChatId === "string" ? raw.guardianChatId : undefined,
    guardianExternalUserId:
      typeof raw.guardianExternalUserId === "string"
        ? raw.guardianExternalUserId
        : undefined,
    guardianPrincipalId:
      typeof raw.guardianPrincipalId === "string"
        ? raw.guardianPrincipalId
        : undefined,
    requesterIdentifier:
      typeof raw.requesterIdentifier === "string"
        ? raw.requesterIdentifier
        : undefined,
    requesterDisplayName:
      typeof raw.requesterDisplayName === "string"
        ? raw.requesterDisplayName
        : undefined,
    requesterSenderDisplayName:
      typeof raw.requesterSenderDisplayName === "string"
        ? raw.requesterSenderDisplayName
        : undefined,
    requesterMemberDisplayName:
      typeof raw.requesterMemberDisplayName === "string"
        ? raw.requesterMemberDisplayName
        : undefined,
    requesterExternalUserId:
      typeof raw.requesterExternalUserId === "string"
        ? raw.requesterExternalUserId
        : undefined,
    requesterChatId:
      typeof raw.requesterChatId === "string" ? raw.requesterChatId : undefined,
    requesterContactId:
      typeof raw.requesterContactId === "string"
        ? raw.requesterContactId
        : undefined,
    memberStatus:
      typeof raw.memberStatus === "string" ? raw.memberStatus : undefined,
    memberPolicy:
      typeof raw.memberPolicy === "string" ? raw.memberPolicy : undefined,
    requesterTimezone:
      typeof raw.requesterTimezone === "string"
        ? raw.requesterTimezone
        : undefined,
    requesterTimezoneLabel:
      typeof raw.requesterTimezoneLabel === "string"
        ? raw.requesterTimezoneLabel
        : undefined,
    requesterTimezoneOffsetSeconds:
      typeof raw.requesterTimezoneOffsetSeconds === "number"
        ? raw.requesterTimezoneOffsetSeconds
        : undefined,
  };
}

/**
 * Read the full `slackInbound` the live path captured onto the payload (via
 * `storeInboundSlackMetadata`). This is the PREFERRED source on replay: it is
 * the EXACT object the live turn used, so `deriveIngressIdempotencyKey` (in
 * `process-message.ts`) produces a byte-identical `client_message_id` — a replay
 * of a turn a prior attempt already persisted (e.g. a crash after the user row
 * was written but before the event was marked processed) then dedups on
 * `(conversation_id, client_message_id)` instead of running the agent loop again
 * and double-posting — and full slackMeta survives onto the replayed row.
 */
function parseStoredSlackInbound(
  value: unknown,
): SlackInboundMessageMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.channelId !== "string" || typeof obj.channelTs !== "string") {
    return undefined;
  }
  // Required fields validated above; optional slackMeta fields flow through as
  // stored (this is our own persisted JSON, and downstream slackMeta building
  // treats every optional field defensively).
  return obj as unknown as SlackInboundMessageMetadata;
}

/**
 * Fallback for payloads stored before {@link parseStoredSlackInbound}'s capture
 * existed: reconstruct the minimal `{ channelId, channelTs }` from fields the
 * payload has always carried, so those in-flight events still dedup on replay.
 * `channelTs` mirrors the live `sourceMessageId ?? externalMessageId` derivation.
 * slackMeta is partial here (only the key-bearing fields), which is acceptable
 * for the short drain window of pre-upgrade retries.
 */
function buildReplaySlackInbound(params: {
  sourceChannel: ChannelId;
  externalChatId: string | undefined;
  sourceMetadata: import("@vellumai/gateway-client").SourceMetadata | undefined;
  externalMessageId: string | undefined;
}): SlackInboundMessageMetadata | undefined {
  if (params.sourceChannel !== "slack" || !params.externalChatId) {
    return undefined;
  }
  const channelTs =
    (typeof params.sourceMetadata?.messageId === "string"
      ? params.sourceMetadata.messageId
      : undefined) ?? params.externalMessageId;
  if (!channelTs) {
    return undefined;
  }
  return { channelId: params.externalChatId, channelTs };
}

/**
 * Periodically retry failed channel inbound events that have passed
 * their exponential backoff delay.
 */
export async function sweepFailedEvents(
  processMessage: MessageProcessor,
): Promise<void> {
  const events = getRetryableEvents();
  const deliveryEvents = getRetryableDeliveryEvents();
  if (events.length === 0 && deliveryEvents.length === 0) {
    return;
  }

  log.info(
    { processingCount: events.length, deliveryCount: deliveryEvents.length },
    "Retrying failed channel inbound events",
  );

  for (const event of events) {
    if (!event.rawPayload) {
      // No payload stored -- can't replay, move to dead letter
      recordProcessingFailure(
        event.id,
        new Error("No raw payload stored for replay"),
      );
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.rawPayload) as Record<string, unknown>;
    } catch {
      recordProcessingFailure(
        event.id,
        new Error("Failed to parse stored raw payload"),
      );
      continue;
    }

    const content =
      typeof payload.content === "string" ? payload.content.trim() : "";
    const attachmentIds = Array.isArray(payload.attachmentIds)
      ? (payload.attachmentIds as string[])
      : undefined;
    const sourceChannel = parseChannelId(payload.sourceChannel);
    if (!sourceChannel) {
      recordProcessingFailure(
        event.id,
        new Error(`Invalid sourceChannel: ${String(payload.sourceChannel)}`),
      );
      continue;
    }
    const sourceInterface =
      parseInterfaceId(payload.interface) ??
      parseInterfaceId(payload.sourceChannel) ??
      "web";
    const sourceMetadata = payload.sourceMetadata as
      | import("@vellumai/gateway-client").SourceMetadata
      | undefined;
    const assistantId =
      typeof payload.assistantId === "string" ? payload.assistantId : undefined;
    const rawTrustCtx = payload.trustCtx;
    const parsedTrustContext = parseTrustRuntimeContext(rawTrustCtx);

    // If the stored payload had guardian context data but it couldn't be parsed
    // into a valid canonical shape (e.g., legacy actorRole-only payloads without
    // trustClass), fail the event deterministically rather than processing it
    // without guardian context. Without this check, the downstream default of
    // `trustClass ?? 'guardian'` would silently escalate privileges.
    if (rawTrustCtx && !parsedTrustContext) {
      log.warn(
        { eventId: event.id },
        "Stored trustCtx could not be parsed into canonical form; marking event as failed to prevent privilege escalation",
      );
      markRetryableFailure(
        event.id,
        "Unparseable guardian context in stored payload — refusing to process without trust classification",
      );
      continue;
    }

    // When trustCtx is entirely absent (pre-guardian events or events stored
    // before trust context was added), synthesize an explicit 'unknown' context.
    // This ensures replay never proceeds without an explicit trust classification
    // — downstream defaults like `trustClass ?? 'guardian'` would
    // otherwise grant guardian-level tool access to unclassified events.
    const trustContext: TrustContext = parsedTrustContext ?? {
      sourceChannel,
      trustClass: "unknown",
    };

    const diskPressureDecision = classifyDiskPressureTurnPolicy(
      getDiskPressureStatus(),
      {
        sourceChannel,
        sourceInterface,
        trustContext: {
          sourceChannel: trustContext.sourceChannel,
          trustClass: trustContext.trustClass,
        },
      },
    );
    if (diskPressureDecision.action === "block") {
      clearPayload(event.id);
      markProcessed(event.id);
      log.info(
        {
          eventId: event.id,
          conversationId: event.conversationId,
          reason: diskPressureDecision.reason,
          trustClass: trustContext.trustClass,
        },
        "Skipped channel retry during disk pressure cleanup mode",
      );

      const replyCallbackUrl =
        typeof payload.replyCallbackUrl === "string"
          ? payload.replyCallbackUrl
          : undefined;
      const externalChatId =
        typeof payload.externalChatId === "string"
          ? payload.externalChatId
          : undefined;
      if (replyCallbackUrl && externalChatId) {
        const requesterExternalUserId =
          trustContext.requesterExternalUserId ??
          (typeof payload.senderExternalUserId === "string"
            ? payload.senderExternalUserId
            : undefined);
        const replyPayload: Parameters<typeof deliverChannelReply>[1] = {
          chatId: externalChatId,
          text: DISK_PRESSURE_REMOTE_BLOCK_REPLY,
          assistantId,
        };
        if (sourceChannel === "slack" && requesterExternalUserId) {
          replyPayload.ephemeral = true;
          replyPayload.user = requesterExternalUserId;
        }
        try {
          await deliverChannelReply(replyCallbackUrl, replyPayload);
        } catch (err) {
          log.warn(
            { err, eventId: event.id, conversationId: event.conversationId },
            "Failed to deliver disk pressure retry block reply",
          );
        }
      }
      continue;
    }

    const metadataHintsRaw = sourceMetadata?.hints;
    const metadataHints = Array.isArray(metadataHintsRaw)
      ? metadataHintsRaw.filter(
          (h): h is string => typeof h === "string" && h.trim().length > 0,
        )
      : [];
    const metadataUxBrief =
      typeof sourceMetadata?.uxBrief === "string" &&
      sourceMetadata.uxBrief.trim().length > 0
        ? sourceMetadata.uxBrief.trim()
        : undefined;
    const metadataChatType =
      typeof sourceMetadata?.chatType === "string" &&
      sourceMetadata.chatType.trim().length > 0
        ? sourceMetadata.chatType.trim()
        : undefined;
    const replyCallbackUrl =
      typeof payload.replyCallbackUrl === "string"
        ? payload.replyCallbackUrl
        : undefined;
    const externalChatId =
      typeof payload.externalChatId === "string"
        ? payload.externalChatId
        : undefined;
    const externalMessageId =
      typeof payload.externalMessageId === "string"
        ? payload.externalMessageId
        : undefined;
    // A retry never opens a new stream: a prior attempt may already have
    // streamed a message, so re-streaming would duplicate the reply. The
    // durable delivery below edits that message in place when one exists.
    const priorStreamMessageTs =
      typeof payload.slackStreamMessageTs === "string"
        ? payload.slackStreamMessageTs
        : undefined;
    let replyMessageId: string | undefined;
    const observeAgentEvent = (msg: ServerMessage): void => {
      if (
        msg.type === "message_complete" &&
        (msg.source === undefined || msg.source === "main") &&
        typeof msg.messageId === "string"
      ) {
        replyMessageId = msg.messageId;
      }
    };

    // Defer — don't dead-letter — a retry whose conversation is mid-turn. The
    // sweep runs turns directly (no admission gate), so reprocessing a busy
    // conversation throws the busy error, and `recordProcessingFailure`
    // classifies that as fatal → `dead_letter`. Re-schedule it without burning a
    // retry attempt (`deferRetryUntilIdle`) so a long in-flight turn can never
    // exhaust the budget and drop the reply; a later sweep reprocesses once the
    // lock frees. This is the sweep-side counterpart to the inbound
    // defer-until-idle admission in `channel-turn-admission.ts`.
    if (findConversation(event.conversationId)?.isProcessing()) {
      log.info(
        { eventId: event.id, conversationId: event.conversationId },
        "Channel retry deferred: conversation is mid-turn",
      );
      deferRetryUntilIdle(event.id);
      continue;
    }

    // Prepare the replayed turn exactly as the live ingress path did: fence
    // non-guardian content in `<external_content>` (the stored payload holds the
    // raw, unwrapped text), and replay the Slack ingress metadata — the captured
    // `slackInbound` when present (identical idempotency key + full slackMeta),
    // else the reconstructed fallback — so a replay of an already-persisted turn
    // dedups instead of running a second agent loop.
    const prepared = prepareChannelInboundContent({
      trimmedContent: content,
      trustClass: trustContext.trustClass,
      sourceChannel,
      requesterIdentifier: trustContext.requesterIdentifier,
    });
    const replaySlackInbound =
      parseStoredSlackInbound(payload.slackInbound) ??
      buildReplaySlackInbound({
        sourceChannel,
        externalChatId,
        sourceMetadata,
        externalMessageId,
      });

    // Shared replay options. The idempotency-bearing `slackInbound` is added
    // only on the first attempt; the incomplete-turn re-run below omits it so it
    // does not dedup against the very row it needs to complete.
    const replayOptions = {
      attachmentIds,
      transport: {
        channelId: sourceChannel,
        hints: metadataHints.length > 0 ? metadataHints : undefined,
        uxBrief: metadataUxBrief,
        chatType: metadataChatType,
      },
      assistantId,
      trustContext,
      isInteractive:
        resolveRoutingStateFromRuntime(trustContext).promptWaitingAllowed,
      onEvent: observeAgentEvent,
      sourceChannel,
      sourceInterface,
      ...(prepared.displayContent !== undefined
        ? { displayContent: prepared.displayContent }
        : {}),
    };

    let userMessageId: string | undefined;
    let deduplicatedIngress = false;
    try {
      let result = await processMessage(
        event.conversationId,
        prepared.content,
        {
          ...replayOptions,
          ...(replaySlackInbound ? { slackInbound: replaySlackInbound } : {}),
        },
      );
      // A dedup hit means a prior attempt of this event already persisted the
      // user row. If that attempt crashed before writing any assistant reply,
      // the dedup skipped the agent loop and there is nothing to deliver — so
      // complete the turn with a fresh run (omitting `slackInbound` so it does
      // not dedup again) rather than marking it processed with a silent
      // no-reply. Rare: a crash between the user-row write and the first
      // assistant token. (The fresh run persists a second user row; a
      // resume-in-place path that avoids that is tracked as a follow-up.)
      if (
        result.deduplicated &&
        !findAssistantReplyMessageIdForTurn(
          event.conversationId,
          result.messageId,
        )
      ) {
        log.info(
          { eventId: event.id, conversationId: event.conversationId },
          "Deduplicated replay has no reply; completing the turn with a fresh run",
        );
        result = await processMessage(
          event.conversationId,
          prepared.content,
          replayOptions,
        );
      }
      deduplicatedIngress = result.deduplicated === true;
      userMessageId = result.messageId;
      linkMessage(event.id, userMessageId);
      markProcessed(event.id);
      replyMessageId ??= result.assistantMessageId;
      if (replyMessageId) {
        storeReplyMessageId(event.id, replyMessageId);
      }
      log.info(
        { eventId: event.id },
        "Successfully replayed failed channel event",
      );
    } catch (err) {
      if (isConversationBusyError(err)) {
        // The conversation took its processing lock between the pre-check above
        // and this call. Same treatment: re-schedule without burning an attempt,
        // never a fatal dead-letter.
        log.info(
          { eventId: event.id, conversationId: event.conversationId },
          "Channel retry hit the processing lock; deferring to a later sweep",
        );
        deferRetryUntilIdle(event.id);
        continue;
      }
      log.error({ err, eventId: event.id }, "Retry failed for channel event");
      recordProcessingFailure(event.id, err);
      continue;
    }

    // Skip delivery when the replay deduplicated AND a sibling event already
    // owns delivery of this turn's reply — otherwise finalizeEventDelivery would
    // re-post a reply the owning event already delivered (double-post). Mirrors
    // background-dispatch via the shared ownership check. With no such sibling,
    // the prior attempt died before delivering, so this replay delivers once,
    // editing any streamed message in place via `priorStreamMessageTs`.
    if (
      deduplicatedIngress &&
      userMessageId &&
      isDeduplicatedDeliveryOwnedBySibling(userMessageId, event.id)
    ) {
      log.info(
        { eventId: event.id, conversationId: event.conversationId },
        "Skipping retry delivery: a sibling event owns delivery for the deduplicated turn",
      );
    } else if (replyCallbackUrl && externalChatId) {
      try {
        await finalizeEventDelivery({
          eventId: event.id,
          conversationId: event.conversationId,
          externalChatId,
          replyCallbackUrl,
          assistantId,
          replyMessageId,
          userMessageId,
          slackReplySession: undefined,
          priorStreamMessageTs,
        });
      } catch (err) {
        log.error(
          { err, eventId: event.id },
          "Retry delivery failed for channel event",
        );
      }
    }
  }

  for (const event of deliveryEvents) {
    if (!event.rawPayload) {
      recordDeliveryFailure(
        event.id,
        new Error("No raw payload stored for delivery retry"),
      );
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.rawPayload) as Record<string, unknown>;
    } catch {
      recordDeliveryFailure(
        event.id,
        new Error("Failed to parse stored raw payload for delivery retry"),
      );
      continue;
    }

    const replyCallbackUrl =
      typeof payload.replyCallbackUrl === "string"
        ? payload.replyCallbackUrl
        : undefined;
    const externalChatId =
      typeof payload.externalChatId === "string"
        ? payload.externalChatId
        : undefined;
    let replyMessageId =
      typeof payload.replyMessageId === "string"
        ? payload.replyMessageId
        : undefined;
    const assistantId =
      typeof payload.assistantId === "string" ? payload.assistantId : undefined;
    // A prior attempt may already have streamed a message; its first
    // undelivered segment edits that message in place rather than posting a
    // duplicate reply beside it.
    const priorStreamMessageTs =
      typeof payload.slackStreamMessageTs === "string"
        ? payload.slackStreamMessageTs
        : undefined;
    if (!replyCallbackUrl || !externalChatId) {
      recordDeliveryFailure(
        event.id,
        new Error("Stored payload is missing delivery callback details"),
      );
      continue;
    }
    if (!replyMessageId && event.messageId) {
      replyMessageId = findAssistantReplyMessageIdForTurn(
        event.conversationId,
        event.messageId,
      );
      if (replyMessageId) {
        storeReplyMessageId(event.id, replyMessageId);
      }
    }
    if (!replyMessageId) {
      recordDeliveryFailure(
        event.id,
        new Error("Stored payload is missing assistant reply message id"),
      );
      continue;
    }

    try {
      await deliverReplyViaCallback(
        event.conversationId,
        externalChatId,
        replyCallbackUrl,
        assistantId,
        {
          messageId: replyMessageId,
          // The stored reply id may point at a bare <no_response/> row from
          // the turn's final message; the turn boundary lets delivery fall
          // through to the real reply written earlier in the same turn.
          ...(event.messageId ? { sinceMessageId: event.messageId } : {}),
          startFromSegment: event.deliveredSegmentCount,
          ...(priorStreamMessageTs ? { messageTs: priorStreamMessageTs } : {}),
          onSegmentDelivered: (count) =>
            updateDeliveredSegmentCount(event.id, count),
        },
      );
      markDeliveryDelivered(event.id);
    } catch (err) {
      log.error(
        { err, eventId: event.id },
        "Retry delivery failed for processed channel event",
      );
      recordDeliveryFailure(event.id, err);
    }
  }
}
