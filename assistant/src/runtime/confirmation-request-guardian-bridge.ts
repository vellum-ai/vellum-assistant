/**
 * Bridge confirmation_request events to guardian.question notifications.
 *
 * When a channel session creates a confirmation_request (tool approval), this
 * helper emits a guardian.question notification signal and persists
 * guardian-request delivery rows to guardian destinations
 * (Telegram/Slack/Vellum), enabling the guardian to approve via
 * callback/request-code path.
 *
 * Two kinds of turn reach here. A contact's sensitive tool call escalates
 * because the contact may not decide it. A guardian's own prompt bridges for
 * a different reason: they may decide it, but the card is the only surface
 * addressed to them rather than to whatever chat the turn is running in.
 *
 * Modeled after the tool-grant-request-helper pattern. Designed to be called from
 * both the daemon event registrar (server.ts) and the HTTP hub publisher
 * (conversation-routes.ts) — the two paths that create confirmation_request
 * guardian requests.
 */

import { isNotificationDeliverable } from "../channels/config.js";
import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";
import type { ChannelId } from "../channels/types.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/guardian-delivery-recorder.js";
import { buildVellumCardAffinity } from "../notifications/vellum-card-affinity.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import { resolveApprovalSourceReference } from "./approval-source-link.js";
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
// Surface rule
// ---------------------------------------------------------------------------

/**
 * Whether a guardian's own gated tool prompt is delivered as a guardian card.
 *
 * A guardian is `self` on the sensitive-tool gate, so that gate lets their
 * call proceed, but the risk/threshold policy still parks an interactive
 * prompt they have to answer. That prompt needs a surface, and there are only
 * two: a card addressed to the guardian, or the in-turn rail's message posted
 * into the chat the turn is running in.
 *
 * The card wins wherever it can be delivered, because the rail's message
 * addresses a room rather than a person. Two cases it cannot cover, which the
 * rail keeps:
 *
 * - `vellum`: the app renders the confirmation itself, so a card would be a
 *   second copy of a prompt already on screen.
 * - a channel the notification pipeline cannot deliver on, which has no
 *   destination resolver and no guardian endpoint to address.
 *
 * Exported because the rail reads the same rule to decide whether to stay out
 * of the way. Both must answer identically for one prompt to reach one place;
 * two copies of this condition would eventually disagree and deliver the
 * prompt twice, or not at all.
 */
export function guardianPromptDeliveredAsCard(params: {
  trustClass: TrustContext["trustClass"];
  sourceChannel: ChannelId;
}): boolean {
  const { trustClass, sourceChannel } = params;
  if (resolveCapabilities(trustClass).sensitiveToolApproval !== "self") {
    return false;
  }
  return sourceChannel !== "vellum" && isNotificationDeliverable(sourceChannel);
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Bridge a confirmation_request to a guardian.question notification.
 *
 * Emits for a contact whose sensitive tool call escalates-and-waits, and for a
 * guardian's own prompt wherever a card can carry it. Unknown actors are
 * skipped, already fail-closed by the routing layer. Every path still needs a
 * resolvable guardian binding on the turn's channel.
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

  const sourceChannel = trustContext.sourceChannel;

  // Who needs a card, by what the actor may do with a sensitive tool:
  //
  // - `escalate-and-wait` (contacts): the guardian decides on the contact's
  //   behalf, so the card is the escalation itself.
  // - `self` (guardian): the tool gate lets them proceed, but the
  //   risk/threshold policy still parks a prompt they have to answer, and on
  //   a channel the card is the only surface addressed to them rather than to
  //   the room. See {@link guardianPromptDeliveredAsCard} for where the rail
  //   keeps it instead.
  // - `deny` (unknown): fail-closed before a prompt is ever parked, so there
  //   is nothing to decide. Kept as an explicit skip rather than left to that
  //   guarantee, because the two non-confirmation callers of this bridge do
  //   not share it.
  const { sensitiveToolApproval } = resolveCapabilities(
    trustContext.trustClass,
  );
  const bridgeable =
    sensitiveToolApproval === "escalate-and-wait" ||
    guardianPromptDeliveredAsCard({
      trustClass: trustContext.trustClass,
      sourceChannel,
    });
  if (!bridgeable) {
    return { skipped: true, reason: "not_bridgeable_trust_class" };
  }

  if (!trustContext.guardianExternalUserId) {
    log.debug(
      { conversationId, sourceChannel },
      "Skipping guardian bridge: no guardian identity on the turn's trust context",
    );
    return { skipped: true, reason: "missing_guardian_identity" };
  }

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
    // Pin the in-app (vellum) card to the conversation the confirmation was
    // emitted in, so the guardian decides it in context.
    ...(buildVellumCardAffinity(conversationId) ?? {}),
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
      // Reference to the channel message that triggered the confirmation, so
      // approval cards can link the guardian back to the source conversation.
      // The hint's field names match TrustContext, so it passes straight through.
      ...resolveApprovalSourceReference(
        sourceChannel,
        conversationId,
        trustContext,
      ),
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
