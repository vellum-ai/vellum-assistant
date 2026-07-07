/**
 * Shared access-request creation and notification helper.
 *
 * Encapsulates the "create/dedupe canonical access request + emit notification"
 * logic so both text-channel and voice-channel ingress paths use identical
 * guardian notification flows.
 *
 * Access requests are a special case: they always create a canonical request
 * and emit a notification signal, even when no same-channel guardian binding
 * exists. Guardian identity resolution is anchored on the assistant's vellum
 * principal so access requests cannot bind to stale/cross-assistant contacts.
 */

import type { ChannelId } from "../channels/types.js";
import {
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from "../contacts/canonical-guardian-store.js";
import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import type { ChannelStatus } from "../contacts/types.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/canonical-delivery-recorder.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { GuardianResolutionSource } from "../notifications/signal.js";
import { getLogger } from "../util/logger.js";
import { resolveAnchoredGuardian } from "./anchored-guardian.js";
import { CHALLENGE_TTL_MS } from "./channel-verification-service.js";
import { serializeRequesterSignals } from "./introduction-policy.js";
import { GUARDIAN_APPROVAL_TTL_MS } from "./routes/channel-route-shared.js";

const log = getLogger("access-request-helper");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What prompted the introduction card. `denied` — the sender was refused
 * (ACL or admission floor) and the guardian decides whether to let them in.
 * `admitted` — the sender cleared the admission floor without ever being
 * classified, and the guardian is nudged to set their trust level while the
 * conversation proceeds. Copy branches on this; decision semantics and the
 * offered actions are identical.
 */
export type AccessRequestTrigger = "denied" | "admitted";

export interface AccessRequestParams {
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  actorExternalId?: string;
  actorDisplayName?: string;
  actorUsername?: string;
  previousMemberStatus?: Exclude<ChannelStatus, "unverified">;
  /** Preview of the requester's original message, shown to the guardian. */
  messagePreview?: string;
  /** The sender is a bot / integration account (no verification handshake possible). */
  isBot?: boolean;
  /** Slack-specific: user is from an external workspace (Slack Connect). */
  isStranger?: boolean;
  /** Slack-specific: user is a guest / restricted account. */
  isRestricted?: boolean;
  /** Slack message timestamp for permalink construction. */
  messageTs?: string;
  /** Defaults to `denied` — see {@link AccessRequestTrigger}. */
  trigger?: AccessRequestTrigger;
}

export type AccessRequestResult =
  | { notified: true; created: boolean; requestId: string }
  | {
      notified: false;
      reason:
        | "no_sender_id"
        | "already_denied"
        | "already_introduced"
        | "approval_pending_verification";
    };

// ---------------------------------------------------------------------------
// Terminal-deny lookup
// ---------------------------------------------------------------------------

/**
 * Assistant-scoped conversation id for an actor's access requests. Stable key
 * that dedupes pending prompts and detects a prior terminal deny for the same
 * (assistant, channel, actor).
 */
export function accessRequestConversationId(
  canonicalAssistantId: string,
  sourceChannel: string,
  actorExternalId: string,
): string {
  return `access-req-${canonicalAssistantId}-${sourceChannel}-${actorExternalId}`;
}

/**
 * Whether the guardian has already terminally denied an access request from
 * this actor on this channel. Callers use it to suppress re-engagement — both
 * the guardian prompt and the self-verify challenge — for a sender the guardian
 * explicitly rejected. Reads the retained `denied` canonical request scoped by
 * the assistant-scoped conversation id.
 */
export function isAccessRequestDenied(params: {
  canonicalAssistantId: string;
  sourceChannel: string;
  actorExternalId: string;
}): boolean {
  const conversationId = accessRequestConversationId(
    params.canonicalAssistantId,
    params.sourceChannel,
    params.actorExternalId,
  );
  return (
    listCanonicalGuardianRequests({
      status: "denied",
      requesterExternalUserId: params.actorExternalId,
      sourceChannel: params.sourceChannel,
      kind: "access_request",
      conversationId,
    }).length > 0
  );
}

/**
 * Whether this sender is inside the post-approval verification window: the
 * guardian approved their access request recently enough that the minted
 * 6-digit code could still be redeemable. In that state the handshake is in
 * progress — the sender needs to enter the code, not trigger a fresh access
 * request.
 *
 * Keyed on the approval decision time (the request row's `updatedAt`) bounded
 * by the verification-code TTL, deliberately NOT on live verification-session
 * rows: session lookups cannot distinguish the approval-minted session from a
 * self-verify challenge session the ACL mints on the same inbound, or from an
 * unrelated session bound to the same identity (guardian-initiated
 * verification, invites).
 *
 * Voice is excluded: phone approvals activate the caller directly and never
 * mint a code.
 */
export function isApprovalHandshakeInProgress(params: {
  canonicalAssistantId: string;
  sourceChannel: string;
  actorExternalId: string;
}): boolean {
  if (params.sourceChannel === "phone") {
    return false;
  }
  const conversationId = accessRequestConversationId(
    params.canonicalAssistantId,
    params.sourceChannel,
    params.actorExternalId,
  );
  const windowStart = Date.now() - CHALLENGE_TTL_MS;
  return listCanonicalGuardianRequests({
    status: "approved",
    requesterExternalUserId: params.actorExternalId,
    sourceChannel: params.sourceChannel,
    kind: "access_request",
    conversationId,
  }).some((request) => request.updatedAt >= windowStart);
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Create/dedupe a canonical access request and emit a notification signal
 * so the guardian can approve or deny the unknown sender.
 *
 * Returns a result indicating whether the guardian was notified and whether
 * a new request was created or an existing one was deduped.
 *
 * Guardian identity resolution uses the assistant's vellum principal as the
 * trust anchor and only accepts source-channel contacts that match it. This
 * prevents stale or cross-assistant contacts from being bound to the request.
 *
 * The canonical store writes complete before this resolves; the notification
 * signal emission is fire-and-forget.
 */
export async function notifyGuardianOfAccessRequest(
  params: AccessRequestParams,
): Promise<AccessRequestResult> {
  const {
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    actorExternalId,
    actorDisplayName,
    actorUsername,
    previousMemberStatus,
    messagePreview,
    isBot,
    isStranger,
    isRestricted,
    messageTs,
  } = params;
  const trigger: AccessRequestTrigger = params.trigger ?? "denied";

  if (!actorExternalId) {
    return { notified: false, reason: "no_sender_id" };
  }

  // Resolve guardian identity with the assistant-anchored strategy (gateway
  // source-channel match validated against the vellum anchor, else the vellum
  // anchor).
  const anchored = resolveAnchoredGuardian({
    guardians: await getGuardianDelivery(),
    sourceChannel,
  });
  const guardianExternalUserId = anchored?.address ?? null;
  const guardianPrincipalId = anchored?.principalId ?? null;
  const guardianBindingChannel = anchored?.channelType ?? null;
  const guardianResolutionSource: GuardianResolutionSource =
    anchored?.source ?? "none";

  log.debug(
    {
      sourceChannel,
      source: guardianResolutionSource,
      hasGuardianPrincipal: !!guardianPrincipalId,
      guardianBindingChannel,
    },
    "access request guardian resolved",
  );

  // The conversationId is assistant-scoped so the dedupe query below only
  // matches requests for the same assistant. Without this, a pending request
  // from assistant A could be returned for assistant B, allowing the caller
  // to piggyback on A's guardian approval.
  const conversationId = accessRequestConversationId(
    canonicalAssistantId,
    sourceChannel,
    actorExternalId,
  );

  // Deduplicate: skip creation if there is already a pending canonical request
  // for the same requester on this channel *and* assistant. Still return
  // notified: true with the existing request ID so callers know the guardian
  // was already notified.
  const existingCanonical = listCanonicalGuardianRequests({
    status: "pending",
    requesterExternalUserId: actorExternalId,
    sourceChannel,
    kind: "access_request",
    conversationId,
  });
  if (existingCanonical.length > 0) {
    log.debug(
      { sourceChannel, actorExternalId, existingId: existingCanonical[0].id },
      "Skipping duplicate access request notification",
    );
    return {
      notified: true,
      created: false,
      requestId: existingCanonical[0].id,
    };
  }

  // Terminal-deny suppression: once the guardian has denied an access request
  // for this sender on this channel, subsequent inbound must not re-prompt.
  // The denied decision persists the sender as an unverified_contact (see the
  // accessRequestResolver deny path); re-surfacing the same request the
  // guardian already rejected would be noise. The guardian can still verify the
  // contact manually — that path does not go through here. Checked before the
  // handshake window below so a standing deny always wins over an earlier
  // approval.
  if (
    isAccessRequestDenied({
      canonicalAssistantId,
      sourceChannel,
      actorExternalId,
    })
  ) {
    log.debug(
      { sourceChannel, actorExternalId },
      "Suppressing access request notification — guardian already denied this sender",
    );
    return { notified: false, reason: "already_denied" };
  }

  // Handshake-in-progress suppression: within the verification-code window
  // after the guardian approves, the flow is waiting on the requester to enter
  // their code. Inbound from the sender in that window must not create a new
  // request or re-notify the guardian; once the window lapses unconsumed,
  // re-prompting is allowed again.
  if (
    isApprovalHandshakeInProgress({
      canonicalAssistantId,
      sourceChannel,
      actorExternalId,
    })
  ) {
    log.debug(
      { sourceChannel, actorExternalId },
      "Suppressing access request notification — approval granted, verification window still open",
    );
    return { notified: false, reason: "approval_pending_verification" };
  }

  const senderIdentifier = actorDisplayName || actorUsername || actorExternalId;
  const requestId = `access-req-${canonicalAssistantId}-${sourceChannel}-${actorExternalId}-${Date.now()}`;

  const canonicalRequest = createCanonicalGuardianRequest({
    id: requestId,
    kind: "access_request",
    sourceType: "channel",
    sourceChannel,
    conversationId,
    requesterExternalUserId: actorExternalId,
    requesterChatId: conversationExternalId,
    guardianExternalUserId: guardianExternalUserId ?? undefined,
    guardianPrincipalId: guardianPrincipalId ?? undefined,
    toolName: "ingress_access_request",
    questionText:
      trigger === "admitted"
        ? `${senderIdentifier} messaged the assistant and was admitted — set their trust level`
        : `${senderIdentifier} is requesting access to the assistant`,
    requesterSignals: serializeRequesterSignals({
      isBot,
      isStranger,
      isRestricted,
    }),
    expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
  });

  let vellumDeliveryId: string | undefined;
  // When the access request originates from a text channel with
  // notification delivery support (Slack, Telegram) and the guardian was
  // resolved via a verified same-channel contact, route the notification
  // only to that channel to reduce noise. Phone is excluded because it
  // is not a deliverable notification channel.
  // When the guardian was NOT verified on the source channel (e.g. resolved
  // via vellum anchor), route to all channels so the guardian can see
  // the request on desktop/other channels where they ARE verified.
  const TEXT_CHANNELS_WITH_DELIVERY: ReadonlySet<string> = new Set([
    "slack",
    "telegram",
  ]);
  const sameChannelOnly =
    TEXT_CHANNELS_WITH_DELIVERY.has(sourceChannel) &&
    guardianResolutionSource === "source-channel-contact";

  void emitNotificationSignal({
    sourceEventName: "ingress.access_request",
    sourceChannel,
    sourceContextId: `access-req-${sourceChannel}-${actorExternalId}`,
    requiresConversation: true,
    ...(sameChannelOnly ? { routingIntent: "single_channel" as const } : {}),
    attentionHints: {
      requiresAction: true,
      // An admitted sender is already conversing — the guardian should
      // classify them eventually, but nothing is blocked on the decision.
      urgency: trigger === "admitted" ? "medium" : "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId,
      requestCode: canonicalRequest.requestCode ?? "",
      sourceChannel,
      conversationExternalId,
      actorExternalId,
      actorDisplayName: actorDisplayName ?? null,
      actorUsername: actorUsername ?? null,
      senderIdentifier,
      guardianBindingChannel,
      guardianResolutionSource,
      previousMemberStatus: previousMemberStatus ?? null,
      messagePreview: messagePreview ?? null,
      ...(isBot !== undefined ? { isBot } : {}),
      ...(isStranger !== undefined ? { isStranger } : {}),
      ...(isRestricted !== undefined ? { isRestricted } : {}),
      ...(messageTs ? { messageTs } : {}),
      ...(trigger === "admitted" ? { trigger } : {}),
    },
    dedupeKey: `access-request:${canonicalRequest.id}`,
    onConversationCreated: (info) => {
      if (
        info.sourceEventName !== "ingress.access_request" ||
        vellumDeliveryId
      ) {
        return;
      }
      vellumDeliveryId = recordApprovalCardDelivery({
        requestId: canonicalRequest.id,
        channel: "vellum",
        conversationId: info.conversationId,
      })?.id;
    },
  })
    .then((signalResult) => {
      vellumDeliveryId = recordGuardianRequestDeliveries({
        requestId: canonicalRequest.id,
        deliveryResults: signalResult.deliveryResults,
        vellumDeliveryId,
      });

      if (!vellumDeliveryId && !sameChannelOnly) {
        recordApprovalCardDelivery({
          requestId: canonicalRequest.id,
          channel: "vellum",
          status: "failed",
        });
        log.warn(
          { requestId: canonicalRequest.id, reason: signalResult.reason },
          "Notification pipeline did not produce a vellum delivery result for access request",
        );
      }
    })
    .catch((err) => {
      log.error(
        { err, requestId: canonicalRequest.id, sourceChannel, actorExternalId },
        "Failed to persist access request delivery rows from notification pipeline",
      );
    });

  log.info(
    {
      sourceChannel,
      actorExternalId,
      senderIdentifier,
      guardianBindingChannel,
      trigger,
    },
    "Guardian notified of access request",
  );

  return { notified: true, created: true, requestId: canonicalRequest.id };
}

/**
 * Introduction nudge for a floor-admitted sender (see
 * docs/proposals/introduction-card-on-first-admit.md): fires the standard
 * introduction card so the guardian can classify a sender who cleared the
 * admission floor without ever being reviewed. The conversation proceeds
 * regardless of whether — or how — the guardian decides.
 *
 * At most one nudge per (assistant, channel, actor, conversation): any prior
 * access request whose `requesterChatId` matches this conversation suppresses
 * it, in every terminal state — an admitted sender loses nothing when the
 * guardian ignores the card, so re-prompting in the same conversation is
 * noise. A prior request from a *different* conversation does not suppress
 * (a channel poster who later DMs the assistant is new context worth one more
 * nudge); the actor-level pending-dedupe, terminal-deny, and handshake-window
 * suppressions inside {@link notifyGuardianOfAccessRequest} still apply, so
 * two live cards are never minted for the same actor.
 */
export async function maybeNotifyGuardianOfAdmittedContact(
  params: Omit<AccessRequestParams, "trigger">,
): Promise<AccessRequestResult> {
  if (!params.actorExternalId) {
    return { notified: false, reason: "no_sender_id" };
  }

  const conversationId = accessRequestConversationId(
    params.canonicalAssistantId,
    params.sourceChannel,
    params.actorExternalId,
  );
  const alreadyIntroducedHere = listCanonicalGuardianRequests({
    kind: "access_request",
    requesterExternalUserId: params.actorExternalId,
    sourceChannel: params.sourceChannel,
    conversationId,
  }).some(
    (request) => request.requesterChatId === params.conversationExternalId,
  );
  if (alreadyIntroducedHere) {
    log.debug(
      {
        sourceChannel: params.sourceChannel,
        actorExternalId: params.actorExternalId,
        conversationExternalId: params.conversationExternalId,
      },
      "Suppressing admitted-contact introduction nudge — prior request exists for this conversation",
    );
    return { notified: false, reason: "already_introduced" };
  }

  return notifyGuardianOfAccessRequest({ ...params, trigger: "admitted" });
}
