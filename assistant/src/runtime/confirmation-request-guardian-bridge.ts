/**
 * Bridge trusted-contact confirmation_request events to guardian.question notifications.
 *
 * When a trusted-contact channel session creates a confirmation_request (tool approval),
 * this helper emits a guardian.question notification signal and persists guardian-request
 * delivery rows to guardian destinations (Telegram/Slack/Vellum), enabling the guardian
 * to approve via callback/request-code path.
 *
 * Modeled after the tool-grant-request-helper pattern. Designed to be called from
 * both the daemon event registrar (server.ts) and the HTTP hub publisher
 * (conversation-routes.ts) — the two paths that create confirmation_request
 * guardian requests.
 */

import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/guardian-delivery-recorder.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { resolveCapabilities } from "./capabilities.js";
import { getGuardianBinding } from "./channel-verification-service.js";

const log = getLogger("confirmation-request-guardian-bridge");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeConfirmationRequestParams {
  /** The guardian request already persisted for this confirmation_request. */
  guardianRequest: GuardianRequestWire;
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
        | "not_bridgeable_trust_class"
        | "no_guardian_binding"
        | "missing_guardian_identity"
        | "binding_identity_mismatch";
    };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Bridge a non-guardian contact confirmation_request to a guardian.question
 * notification.
 *
 * Only emits when the session belongs to a trusted_contact or unverified_contact
 * actor with a resolvable guardian binding. Guardian and unknown actors are
 * skipped — guardians self-approve, and unknown actors are already fail-closed
 * by the routing layer.
 *
 * Fire-and-forget safe: notification emission errors are logged but not propagated.
 */
export async function bridgeConfirmationRequestToGuardian(
  params: BridgeConfirmationRequestParams,
): Promise<BridgeConfirmationRequestResult> {
  const {
    guardianRequest,
    trustContext,
    conversationId,
    toolName,
    assistantId = DAEMON_INTERNAL_ASSISTANT_ID,
  } = params;

  // Only bridge for actors whose sensitive tool approval escalates-and-waits.
  // Guardians self-approve and unknown actors are fail-closed by the routing
  // layer, so neither needs a guardian bridge.
  if (
    resolveCapabilities(trustContext.trustClass).sensitiveToolApproval !==
    "escalate-and-wait"
  ) {
    return { skipped: true, reason: "not_bridgeable_trust_class" };
  }

  if (!trustContext.guardianExternalUserId) {
    log.debug(
      { conversationId, sourceChannel: trustContext.sourceChannel },
      "Skipping guardian bridge: no guardian identity on trusted-contact context",
    );
    return { skipped: true, reason: "missing_guardian_identity" };
  }

  const sourceChannel = trustContext.sourceChannel;
  const binding = await getGuardianBinding(assistantId, sourceChannel);
  if (!binding) {
    log.debug(
      { sourceChannel, assistantId },
      "No guardian binding for confirmation request bridge",
    );
    return { skipped: true, reason: "no_guardian_binding" };
  }

  // Validate that the binding's guardian identity matches the request's
  // guardian identity. A mismatch can occur if a guardian rebind happens between
  // message ingress and confirmation emission — sending the notification to the
  // new binding would leak requester/tool metadata to the wrong recipient.
  //
  // Both sides are canonicalized before comparison because the request's
  // guardian id was normalized by toTrustContext() (verdict and local resolution
  // both route through it) while the binding stores the raw identity. On
  // phone channels the same guardian can have format variance
  // (e.g. "+1 555-123-4567" vs "+15551234567") that would cause a false mismatch.
  const canonicalizedBindingGuardianId = canonicalizeInboundIdentity(
    sourceChannel,
    binding.guardianExternalUserId,
  );
  const canonicalizedRequestGuardianId = guardianRequest.guardianExternalUserId
    ? canonicalizeInboundIdentity(
        sourceChannel,
        guardianRequest.guardianExternalUserId,
      )
    : null;
  if (
    canonicalizedRequestGuardianId &&
    canonicalizedBindingGuardianId !== canonicalizedRequestGuardianId
  ) {
    log.warn(
      {
        sourceChannel,
        assistantId,
        bindingGuardianId: binding.guardianExternalUserId,
        expectedGuardianId: guardianRequest.guardianExternalUserId,
        requestId: guardianRequest.id,
      },
      "Guardian binding identity does not match the request guardian — skipping notification to prevent misrouting",
    );
    return { skipped: true, reason: "binding_identity_mismatch" };
  }

  const senderLabel =
    trustContext.requesterIdentifier ||
    trustContext.requesterExternalUserId ||
    "unknown";

  const questionText = guardianRequest.activityText
    ? `Approve tool: ${toolName} — ${guardianRequest.activityText}`
    : `Approve tool: ${toolName}`;

  // The vellum delivery row is created up front in onConversationCreated so the
  // in-app client sees it immediately; the post-resolve recorder reuses it.
  let vellumDeliveryIdPromise: Promise<string | undefined> | undefined;

  // Emit guardian.question notification so the guardian is alerted.
  const signalPromise = emitNotificationSignal({
    sourceEventName: "guardian.question",
    sourceChannel,
    sourceContextId: conversationId,
    requiresConversation: true,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestKind: "tool_approval",
      requestId: guardianRequest.id,
      requestCode:
        guardianRequest.requestCode ??
        guardianRequest.id.slice(0, 6).toUpperCase(),
      sourceChannel,
      requesterExternalUserId: trustContext.requesterExternalUserId,
      requesterChatId: trustContext.requesterChatId ?? null,
      requesterIdentifier: senderLabel,
      toolName,
      questionText,
      riskLevel: guardianRequest.riskLevel ?? undefined,
      commandPreview: guardianRequest.commandPreview ?? undefined,
    },
    dedupeKey: `tc-confirmation-request:${guardianRequest.id}`,
    // The broadcaster awaits the returned promise, so the delivery row is
    // durable before the client can act on the conversation.
    onConversationCreated: (info) => {
      vellumDeliveryIdPromise ??= recordApprovalCardDelivery({
        requestId: guardianRequest.id,
        channel: "vellum",
        conversationId: info.conversationId,
      }).then((delivery) => delivery?.id);
      return vellumDeliveryIdPromise.then(() => undefined);
    },
  });

  // Record deliveries from the notification pipeline (fire-and-forget).
  void signalPromise
    .then(async (signalResult) => {
      await recordGuardianRequestDeliveries({
        requestId: guardianRequest.id,
        deliveryResults: signalResult.deliveryResults,
        vellumDeliveryId: await vellumDeliveryIdPromise,
      });
    })
    .catch((err) => {
      log.warn(
        { err, requestId: guardianRequest.id },
        "Failed to record channel deliveries for guardian bridge",
      );
    });

  log.info(
    {
      sourceChannel,
      requesterExternalUserId: trustContext.requesterExternalUserId,
      toolName,
      requestId: guardianRequest.id,
      requestCode: guardianRequest.requestCode,
    },
    "Guardian notified of trusted-contact confirmation request",
  );

  // Return the signal ID synchronously from the promise-producing call.
  // The actual signal ID is not available until the promise resolves, but
  // callers only need to know it was bridged — the ID is for diagnostics.
  // We use the guardian request ID as a stable correlation key.
  return { bridged: true, signalId: guardianRequest.id };
}
