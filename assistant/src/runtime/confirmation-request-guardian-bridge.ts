/**
 * Bridge trusted-contact confirmation_request events to guardian.question notifications.
 *
 * When a trusted-contact channel session creates a confirmation_request (tool approval),
 * this helper emits a guardian.question notification signal and persists canonical
 * delivery rows to guardian destinations (Telegram/Slack/Vellum), enabling the guardian
 * to approve via callback/request-code path.
 *
 * Modeled after the tool-grant-request-helper pattern. Designed to be called from
 * both the daemon event registrar (server.ts) and the HTTP hub publisher
 * (conversation-routes.ts) — the two paths that create confirmation_request
 * canonical records.
 */

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import {
  type CanonicalGuardianRequest,
  createCanonicalGuardianDelivery,
} from "../memory/canonical-guardian-store.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { NotificationSourceChannel } from "../notifications/signal.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { getGuardianBinding } from "./channel-verification-service.js";

const log = getLogger("confirmation-request-guardian-bridge");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeConfirmationRequestParams {
  /** The canonical guardian request already persisted for this confirmation_request. */
  canonicalRequest: CanonicalGuardianRequest;
  /** Guardian runtime context from the session. */
  trustContext: TrustContext;
  /** Conversation ID where the confirmation_request was emitted. */
  conversationId: string;
  /** Tool name from the confirmation_request. */
  toolName: string;
  /** Logical assistant ID (defaults to 'self'). */
  assistantId?: string;
}

export type BridgeConfirmationRequestResult =
  | { bridged: true; signalId: string }
  | {
      skipped: true;
      reason:
        | "not_trusted_contact"
        | "no_guardian_binding"
        | "missing_guardian_identity"
        | "binding_identity_mismatch";
    };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Bridge a trusted-contact confirmation_request to a guardian.question notification.
 *
 * Only emits when the session belongs to a trusted-contact actor with a
 * resolvable guardian binding. Guardian and unknown actors are skipped — guardians
 * self-approve, and unknown actors are already fail-closed by the routing layer.
 *
 * Fire-and-forget safe: notification emission errors are logged but not propagated.
 */
export function bridgeConfirmationRequestToGuardian(
  params: BridgeConfirmationRequestParams,
): BridgeConfirmationRequestResult {
  const {
    canonicalRequest,
    trustContext,
    conversationId,
    toolName,
    assistantId = DAEMON_INTERNAL_ASSISTANT_ID,
  } = params;

  // Only bridge for trusted-contact sessions. Guardians self-approve and
  // unknown actors are fail-closed by the routing layer.
  if (trustContext.trustClass !== "trusted_contact") {
    return { skipped: true, reason: "not_trusted_contact" };
  }

  if (!trustContext.guardianExternalUserId) {
    log.debug(
      { conversationId, sourceChannel: trustContext.sourceChannel },
      "Skipping guardian bridge: no guardian identity on trusted-contact context",
    );
    return { skipped: true, reason: "missing_guardian_identity" };
  }

  const sourceChannel = trustContext.sourceChannel;
  const binding = getGuardianBinding(assistantId, sourceChannel);
  if (!binding) {
    log.debug(
      { sourceChannel, assistantId },
      "No guardian binding for confirmation request bridge",
    );
    return { skipped: true, reason: "no_guardian_binding" };
  }

  // Validate that the binding's guardian identity matches the canonical request's
  // guardian identity. A mismatch can occur if a guardian rebind happens between
  // message ingress and confirmation emission — sending the notification to the
  // new binding would leak requester/tool metadata to the wrong recipient.
  //
  // Both sides are canonicalized before comparison because the canonical request
  // value was normalized by resolveTrustContext() while the binding stores the
  // raw identity. On phone channels the same guardian can have format variance
  // (e.g. "+1 555-123-4567" vs "+15551234567") that would cause a false mismatch.
  const canonicalBindingId = canonicalizeInboundIdentity(
    sourceChannel,
    binding.guardianExternalUserId,
  );
  const canonicalRequestId = canonicalRequest.guardianExternalUserId
    ? canonicalizeInboundIdentity(
        sourceChannel,
        canonicalRequest.guardianExternalUserId,
      )
    : null;
  if (canonicalRequestId && canonicalBindingId !== canonicalRequestId) {
    log.warn(
      {
        sourceChannel,
        assistantId,
        bindingGuardianId: binding.guardianExternalUserId,
        expectedGuardianId: canonicalRequest.guardianExternalUserId,
        requestId: canonicalRequest.id,
      },
      "Guardian binding identity does not match canonical request guardian — skipping notification to prevent misrouting",
    );
    return { skipped: true, reason: "binding_identity_mismatch" };
  }

  const senderLabel =
    trustContext.requesterIdentifier ||
    trustContext.requesterExternalUserId ||
    "unknown";

  const questionText = canonicalRequest.activityText
    ? `Tool approval: ${toolName} — ${canonicalRequest.activityText}`
    : `Tool approval request: ${toolName}`;

  // Emit guardian.question notification so the guardian is alerted.
  const signalPromise = emitNotificationSignal({
    sourceEventName: "guardian.question",
    sourceChannel: sourceChannel as NotificationSourceChannel,
    sourceContextId: conversationId,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestKind: "tool_approval" as const,
      requestId: canonicalRequest.id,
      requestCode:
        canonicalRequest.requestCode ??
        canonicalRequest.id.slice(0, 6).toUpperCase(),
      sourceChannel,
      requesterExternalUserId: trustContext.requesterExternalUserId,
      requesterChatId: trustContext.requesterChatId ?? null,
      requesterIdentifier: senderLabel,
      toolName,
      questionText,
    },
    dedupeKey: `tc-confirmation-request:${canonicalRequest.id}`,
    onConversationCreated: (info) => {
      createCanonicalGuardianDelivery({
        requestId: canonicalRequest.id,
        destinationChannel: "vellum",
        destinationConversationId: info.conversationId,
      });
    },
  });

  // Record channel deliveries from the notification pipeline (fire-and-forget).
  void signalPromise
    .then((signalResult) => {
      for (const result of signalResult.deliveryResults) {
        if (result.channel === "vellum") continue; // handled in onConversationCreated
        createCanonicalGuardianDelivery({
          requestId: canonicalRequest.id,
          destinationChannel: result.channel,
          destinationChatId:
            result.destination.length > 0 ? result.destination : undefined,
        });
      }
    })
    .catch((err) => {
      log.warn(
        { err, requestId: canonicalRequest.id },
        "Failed to record channel deliveries for guardian bridge",
      );
    });

  log.info(
    {
      sourceChannel,
      requesterExternalUserId: trustContext.requesterExternalUserId,
      toolName,
      requestId: canonicalRequest.id,
      requestCode: canonicalRequest.requestCode,
    },
    "Guardian notified of trusted-contact confirmation request",
  );

  // Return the signal ID synchronously from the promise-producing call.
  // The actual signal ID is not available until the promise resolves, but
  // callers only need to know it was bridged — the ID is for diagnostics.
  // We use the canonical request ID as a stable correlation key.
  return { bridged: true, signalId: canonicalRequest.id };
}
