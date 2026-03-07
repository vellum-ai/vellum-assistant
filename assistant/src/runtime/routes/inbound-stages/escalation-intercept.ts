/**
 * Ingress escalation stage: when a member's policy is 'escalate', creates
 * a pending guardian approval request, emits a notification signal, and
 * halts the inbound pipeline. The guardian must approve the message
 * before it enters the agent loop.
 *
 * Extracted from inbound-message-handler.ts to keep the top-level handler
 * focused on orchestration.
 */
import type { ChannelId, InterfaceId } from "../../../channels/types.js";
import { createCanonicalGuardianRequest } from "../../../memory/canonical-guardian-store.js";
import * as deliveryCrud from "../../../memory/delivery-crud.js";
import { emitNotificationSignal } from "../../../notifications/emit-signal.js";
import type { NotificationSourceChannel } from "../../../notifications/signal.js";
import { getLogger } from "../../../util/logger.js";
import { getGuardianBinding } from "../../channel-verification-service.js";
import { GUARDIAN_APPROVAL_TTL_MS } from "../channel-route-shared.js";
import type { ResolvedMember } from "./acl-enforcement.js";

const log = getLogger("runtime-http");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EscalationInterceptParams {
  resolvedMember: ResolvedMember | null;
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId;
  conversationExternalId: string;
  externalMessageId: string;
  conversationId: string;
  eventId: string;
  content: string | undefined;
  attachmentIds: string[] | undefined;
  sourceMetadata: Record<string, unknown> | undefined;
  actorDisplayName: string | undefined;
  actorExternalId: string | undefined;
  actorUsername: string | undefined;
  replyCallbackUrl: string | undefined;
  canonicalSenderId: string | null;
  rawSenderId: string | undefined;
}

/**
 * Check whether the resolved member has an 'escalate' policy and, if so,
 * create a guardian approval request and emit a notification.
 *
 * Returns a Response if the escalation was handled (the pipeline should
 * short-circuit), or null to continue the pipeline.
 */
export function handleEscalationIntercept(
  params: EscalationInterceptParams,
): Response | null {
  const {
    resolvedMember,
    canonicalAssistantId,
    sourceChannel,
    sourceInterface,
    conversationExternalId,
    externalMessageId,
    conversationId,
    eventId,
    content,
    attachmentIds,
    sourceMetadata,
    actorDisplayName,
    actorExternalId,
    actorUsername,
    replyCallbackUrl,
    canonicalSenderId,
    rawSenderId,
  } = params;

  if (resolvedMember?.channel.policy !== "escalate") {
    return null;
  }

  const binding = getGuardianBinding(canonicalAssistantId, sourceChannel);
  if (!binding) {
    // Fail-closed: can't escalate without a guardian to route to
    log.info(
      { sourceChannel, channelId: resolvedMember.channel.id },
      "Ingress ACL: escalate policy but no guardian binding, denying",
    );
    return Response.json({
      accepted: true,
      denied: true,
      reason: "escalate_no_guardian",
    });
  }

  // Persist the raw payload so the decide handler can recover the original
  // message content when the escalation is approved.
  deliveryCrud.storePayload(eventId, {
    sourceChannel,
    interface: sourceInterface,
    externalChatId: conversationExternalId,
    externalMessageId,
    content,
    attachmentIds,
    sourceMetadata,
    senderName: actorDisplayName,
    senderExternalUserId: actorExternalId,
    senderUsername: actorUsername,
    replyCallbackUrl,
    assistantId: canonicalAssistantId,
  });

  try {
    createCanonicalGuardianRequest({
      kind: "tool_approval",
      sourceType: "channel",
      sourceChannel,
      conversationId,
      requesterExternalUserId: canonicalSenderId ?? rawSenderId ?? undefined,
      guardianExternalUserId: binding.guardianExternalUserId,
      guardianPrincipalId: binding.guardianPrincipalId,
      toolName: "ingress_message",
      questionText: "Ingress policy requires guardian approval",
      expiresAt: new Date(Date.now() + GUARDIAN_APPROVAL_TTL_MS).toISOString(),
    });
  } catch (err) {
    log.warn(
      { err, conversationId, sourceChannel },
      "Failed to create canonical guardian request for ingress escalation — escalation continues via notification pipeline",
    );
  }

  // Emit notification signal through the unified pipeline (fire-and-forget).
  // This lets the decision engine route escalation alerts to all configured
  // channels, supplementing the direct guardian notification below.
  void emitNotificationSignal({
    sourceEventName: "ingress.escalation",
    sourceChannel: sourceChannel as NotificationSourceChannel,
    sourceSessionId: conversationId,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      conversationId,
      sourceChannel,
      conversationExternalId,
      senderIdentifier:
        actorDisplayName || actorUsername || rawSenderId || "Unknown sender",
      eventId,
    },
    dedupeKey: `escalation:${eventId}`,
  });

  // Guardian escalation channel delivery is handled by the notification
  // pipeline -- no legacy callback dispatch needed.
  log.info(
    { conversationId },
    "Guardian escalation created — notification pipeline handles channel delivery",
  );

  return Response.json({
    accepted: true,
    escalated: true,
    reason: "policy_escalate",
  });
}
