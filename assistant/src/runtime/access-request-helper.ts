/**
 * Shared access-request creation and notification helper.
 *
 * Encapsulates the "create/dedupe guardian access request + emit notification"
 * logic so both text-channel and voice-channel ingress paths use identical
 * guardian notification flows.
 *
 * Access requests are a special case: they always create a guardian request
 * and emit a notification signal, even when no same-channel guardian binding
 * exists. Guardian identity resolution is anchored on the assistant's vellum
 * principal so access requests cannot bind to stale/cross-assistant contacts.
 */

import {
  createGuardianRequest,
  listGuardianRequestsOrEmpty,
} from "../channels/gateway-guardian-requests.js";
import type { ChannelId } from "../channels/types.js";
import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import type { ChannelStatus } from "../contacts/types.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/guardian-delivery-recorder.js";
import type { GuardianResolutionSource } from "../notifications/signal.js";
import { IntegrityError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { resolveAnchoredGuardian } from "./anchored-guardian.js";
import { CHALLENGE_TTL_MS } from "./channel-verification-service.js";
import {
  type AccessRequestTrigger,
  introductionMode,
  serializeRequesterSignals,
} from "./introduction-policy.js";
import { GUARDIAN_APPROVAL_TTL_MS } from "./routes/channel-route-shared.js";

const log = getLogger("access-request-helper");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { AccessRequestTrigger } from "./introduction-policy.js";

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
 * explicitly rejected. Reads the retained `denied` guardian request scoped by
 * the assistant-scoped conversation id.
 *
 * Gateway-unreachable degrades to `false` (no suppression data): callers then
 * proceed toward creation, where the fail-closed create throw is the backstop
 * against prompting without a persisted request.
 */
export async function isAccessRequestDenied(params: {
  canonicalAssistantId: string;
  sourceChannel: string;
  actorExternalId: string;
}): Promise<boolean> {
  const conversationId = accessRequestConversationId(
    params.canonicalAssistantId,
    params.sourceChannel,
    params.actorExternalId,
  );
  const denied = await listGuardianRequestsOrEmpty({
    status: "denied",
    requesterExternalUserId: params.actorExternalId,
    sourceChannel: params.sourceChannel,
    kind: "access_request",
    sourceConversationId: conversationId,
  });
  return denied.length > 0;
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
 *
 * Gateway-unreachable degrades to `false` (window unknown → treat as closed);
 * the worst case is a redundant re-prompt attempt whose create is itself
 * fail-closed.
 */
export async function isApprovalHandshakeInProgress(params: {
  canonicalAssistantId: string;
  sourceChannel: string;
  actorExternalId: string;
}): Promise<boolean> {
  if (params.sourceChannel === "phone") {
    return false;
  }
  const conversationId = accessRequestConversationId(
    params.canonicalAssistantId,
    params.sourceChannel,
    params.actorExternalId,
  );
  const windowStart = Date.now() - CHALLENGE_TTL_MS;
  const approved = await listGuardianRequestsOrEmpty({
    status: "approved",
    requesterExternalUserId: params.actorExternalId,
    sourceChannel: params.sourceChannel,
    kind: "access_request",
    sourceConversationId: conversationId,
  });
  return approved.some((request) => request.updatedAt >= windowStart);
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Create/dedupe a guardian access request and emit a notification signal
 * so the guardian can approve or deny the unknown sender.
 *
 * Returns a result indicating whether the guardian was notified and whether
 * a new request was created or an existing one was deduped.
 *
 * Guardian identity resolution uses the assistant's vellum principal as the
 * trust anchor and only accepts source-channel contacts that match it. This
 * prevents stale or cross-assistant contacts from being bound to the request.
 *
 * The gateway guardian-request writes complete before this resolves; the notification
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

  // Deduplicate: skip creation if there is already a pending guardian request
  // for the same requester on this channel *and* assistant. Still return
  // notified: true with the existing request ID so callers know the guardian
  // was already notified. A degraded (empty) read falls through to creation,
  // whose fail-closed throw prevents a prompt without a persisted request.
  const existingPending = await listGuardianRequestsOrEmpty({
    status: "pending",
    requesterExternalUserId: actorExternalId,
    sourceChannel,
    kind: "access_request",
    sourceConversationId: conversationId,
  });
  if (existingPending.length > 0) {
    log.debug(
      { sourceChannel, actorExternalId, existingId: existingPending[0].id },
      "Skipping duplicate access request notification",
    );
    return {
      notified: true,
      created: false,
      requestId: existingPending[0].id,
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
    await isAccessRequestDenied({
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
    await isApprovalHandshakeInProgress({
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

  // Access requests are decisionable: without a bound principal nobody could
  // ever decide them (mirrors the gateway create's integrity guard).
  if (!guardianPrincipalId) {
    throw new IntegrityError(
      "Cannot create access_request without guardianPrincipalId",
    );
  }

  const guardianRequest = await createGuardianRequest({
    id: requestId,
    kind: "access_request",
    sourceChannel,
    sourceConversationId: conversationId,
    requesterExternalUserId: actorExternalId,
    requesterChatId: conversationExternalId,
    guardianExternalUserId: guardianExternalUserId ?? undefined,
    guardianPrincipalId,
    toolName: "ingress_access_request",
    questionText: introductionMode(trigger).questionText(senderIdentifier),
    requesterSignals: serializeRequesterSignals({
      isBot,
      isStranger,
      isRestricted,
    }),
    // Persisted so decision-time policy (resolvers, expiry sweep) can
    // suppress requester-facing lifecycle notices for admitted-mode nudges.
    ...(trigger === "admitted" ? { requestTrigger: trigger } : {}),
    expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
  });

  let vellumDeliveryIdPromise: Promise<string | undefined> | undefined;
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
      urgency: introductionMode(trigger).urgency,
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId,
      requestCode: guardianRequest.requestCode ?? "",
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
    dedupeKey: `access-request:${guardianRequest.id}`,
    // The callback must stay synchronous; the write is kicked off here and
    // awaited before the post-broadcast recording loop reuses its row id.
    onConversationCreated: (info) => {
      if (
        info.sourceEventName !== "ingress.access_request" ||
        vellumDeliveryIdPromise
      ) {
        return;
      }
      vellumDeliveryIdPromise = recordApprovalCardDelivery({
        requestId: guardianRequest.id,
        channel: "vellum",
        conversationId: info.conversationId,
      }).then((delivery) => delivery?.id);
    },
  })
    .then(async (signalResult) => {
      const vellumDeliveryId = await recordGuardianRequestDeliveries({
        requestId: guardianRequest.id,
        deliveryResults: signalResult.deliveryResults,
        vellumDeliveryId: await vellumDeliveryIdPromise,
      });

      if (!vellumDeliveryId && !sameChannelOnly) {
        await recordApprovalCardDelivery({
          requestId: guardianRequest.id,
          channel: "vellum",
          status: "failed",
        });
        log.warn(
          { requestId: guardianRequest.id, reason: signalResult.reason },
          "Notification pipeline did not produce a vellum delivery result for access request",
        );
      }
    })
    .catch((err) => {
      log.error(
        { err, requestId: guardianRequest.id, sourceChannel, actorExternalId },
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

  return { notified: true, created: true, requestId: guardianRequest.id };
}

/**
 * Introduction nudge for a floor-admitted sender (LUM-2742): fires the
 * standard introduction card so the guardian can classify a sender who
 * cleared the admission floor without ever being reviewed. The conversation proceeds
 * regardless of whether — or how — the guardian decides.
 *
 * At most one nudge per (assistant, channel, actor, external chat): any
 * prior access request whose `requesterChatId` matches this
 * `conversationExternalId` suppresses it, in every terminal state — an
 * admitted sender loses nothing when the guardian ignores the card, so
 * re-prompting in the same chat is noise. The key is the external chat id
 * (a Slack channel or DM, a Telegram chat), deliberately coarser than the
 * per-thread internal conversation rows: threads in one Slack channel share
 * one nudge, so a busy channel cannot mint a card per thread. A prior
 * request from a *different* chat does not suppress (a channel poster who
 * later DMs the assistant is new context worth one more nudge); the
 * actor-level pending-dedupe, terminal-deny, and handshake-window
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
  // Degraded (empty) read lets the nudge proceed; the inner suppressions and
  // the fail-closed create still bound it to at most one live card.
  const priorRequests = await listGuardianRequestsOrEmpty({
    kind: "access_request",
    requesterExternalUserId: params.actorExternalId,
    sourceChannel: params.sourceChannel,
    sourceConversationId: conversationId,
  });
  const alreadyIntroducedHere = priorRequests.some(
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
