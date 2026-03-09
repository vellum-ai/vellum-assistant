/**
 * Tool grant request creation and guardian notification helper.
 *
 * Encapsulates the "create/dedupe canonical tool_grant_request + emit notification"
 * logic so non-guardian channel actors can escalate tool invocations that require
 * guardian approval. Modeled after the access-request-helper pattern.
 *
 * Invariants preserved:
 * - Unverified actors are fail-closed (caller must gate before calling).
 * - Guardians cannot self-approve (grant minting uses guardian identity).
 * - Notification routing goes through emitNotificationSignal().
 */

import type { ChannelId } from "../channels/types.js";
import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from "../memory/canonical-guardian-store.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { NotificationSourceChannel } from "../notifications/signal.js";
import { getLogger } from "../util/logger.js";
import { getGuardianBinding } from "./channel-verification-service.js";
import { GUARDIAN_APPROVAL_TTL_MS } from "./routes/channel-route-shared.js";

const log = getLogger("tool-grant-request-helper");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolGrantRequestParams {
  assistantId: string;
  sourceChannel: ChannelId;
  conversationId: string;
  requesterExternalUserId: string;
  requesterChatId?: string;
  requesterIdentifier?: string;
  toolName: string;
  inputDigest: string;
  questionText: string;
}

export type ToolGrantRequestResult =
  | { created: true; requestId: string; requestCode: string | null }
  | { deduped: true; requestId: string; requestCode: string | null }
  | { failed: true; reason: "no_guardian_binding" | "missing_identity" };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Create/dedupe a canonical tool_grant_request and emit a notification signal
 * so the guardian can approve or deny the tool invocation.
 *
 * Returns a result indicating whether a new request was created, an existing
 * one was deduped, or the escalation failed (no binding, missing identity).
 */
export function createOrReuseToolGrantRequest(
  params: ToolGrantRequestParams,
): ToolGrantRequestResult {
  const {
    assistantId,
    sourceChannel,
    conversationId,
    requesterExternalUserId,
    requesterChatId,
    requesterIdentifier,
    toolName,
    inputDigest,
    questionText,
  } = params;

  if (!requesterExternalUserId) {
    return { failed: true, reason: "missing_identity" };
  }

  const binding = getGuardianBinding(assistantId, sourceChannel);
  if (!binding) {
    log.debug(
      { sourceChannel, assistantId },
      "No guardian binding for tool grant request escalation",
    );
    return { failed: true, reason: "no_guardian_binding" };
  }

  // Deduplicate: skip creation if there is already a pending canonical request
  // for the same requester + conversation + tool + input digest + guardian.
  // Guardian identity is included so that after a guardian rebind, old requests
  // tied to the previous guardian don't block creation of a new approvable request.
  const existing = listCanonicalGuardianRequests({
    status: "pending",
    requesterExternalUserId,
    conversationId,
    kind: "tool_grant_request",
    toolName,
  });
  const dedupeMatch = existing.find(
    (r) =>
      r.inputDigest === inputDigest &&
      r.guardianExternalUserId === binding.guardianExternalUserId,
  );
  if (dedupeMatch) {
    log.debug(
      {
        sourceChannel,
        requesterExternalUserId,
        toolName,
        existingId: dedupeMatch.id,
      },
      "Skipping duplicate tool grant request notification",
    );
    return {
      deduped: true,
      requestId: dedupeMatch.id,
      requestCode: dedupeMatch.requestCode,
    };
  }

  const senderLabel = requesterIdentifier || requesterExternalUserId;
  const requestId = `tool-grant-${assistantId}-${sourceChannel}-${requesterExternalUserId}-${Date.now()}`;

  const canonicalRequest = createCanonicalGuardianRequest({
    id: requestId,
    kind: "tool_grant_request",
    sourceType: "channel",
    sourceChannel,
    conversationId,
    requesterExternalUserId,
    requesterChatId: requesterChatId ?? undefined,
    guardianExternalUserId: binding.guardianExternalUserId,
    guardianPrincipalId: binding.guardianPrincipalId,
    toolName,
    inputDigest,
    questionText,
    expiresAt: new Date(Date.now() + GUARDIAN_APPROVAL_TTL_MS).toISOString(),
  });
  const requestCode =
    canonicalRequest.requestCode ??
    canonicalRequest.id.slice(0, 6).toUpperCase();

  // Emit notification so guardian is alerted. Uses 'guardian.question' as
  // sourceEventName so that existing request-code guidance in the notification
  // pipeline is preserved.
  const signalPromise = emitNotificationSignal({
    sourceEventName: "guardian.question",
    sourceChannel: sourceChannel as NotificationSourceChannel,
    sourceSessionId: conversationId,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId: canonicalRequest.id,
      requestKind: "tool_grant_request",
      requestCode,
      sourceChannel,
      requesterExternalUserId,
      requesterChatId: requesterChatId ?? null,
      requesterIdentifier: senderLabel,
      toolName,
      questionText,
    },
    dedupeKey: `tool-grant-request:${canonicalRequest.id}`,
    onThreadCreated: (info) => {
      createCanonicalGuardianDelivery({
        requestId: canonicalRequest.id,
        destinationChannel: "vellum",
        destinationConversationId: info.conversationId,
      });
    },
  });

  // Record deliveries from the notification pipeline results (fire-and-forget).
  void signalPromise.then((signalResult) => {
    for (const result of signalResult.deliveryResults) {
      if (result.channel === "vellum") continue; // handled in onThreadCreated
      createCanonicalGuardianDelivery({
        requestId: canonicalRequest.id,
        destinationChannel: result.channel,
        destinationChatId:
          result.destination.length > 0 ? result.destination : undefined,
      });
    }
  });

  log.info(
    {
      sourceChannel,
      requesterExternalUserId,
      toolName,
      requestId: canonicalRequest.id,
      requestCode: canonicalRequest.requestCode,
    },
    "Guardian notified of tool grant request",
  );

  return {
    created: true,
    requestId: canonicalRequest.id,
    requestCode: canonicalRequest.requestCode,
  };
}
