/**
 * Resolver registry for guardian requests.
 *
 * The decision primitive validates identity/status, asks the kind's resolver
 * to plan the gateway ACL outcome (`prepare`, before any status write),
 * commits the status CAS + outcome atomically via `guardian_requests_decide`,
 * and then dispatches the kind's daemon-domain follow-through (`resolve`:
 * pending-interaction resume, call answering, notifications, verification-code
 * delivery). Follow-through failures surface as `resolverFailed` but never
 * disturb the committed decision — atomic decide made reopen-on-failed-persist
 * obsolete.
 *
 * The registry is intentionally a simple Map keyed by request kind.  New
 * request kinds can register resolvers here without touching the core
 * decision primitive.
 */

import type { CreateOutboundSessionIpcResponse } from "@vellumai/gateway-client";

import { answerCall } from "../calls/call-domain.js";
import type {
  GuardianRequestAclOutcome,
  GuardianRequestWire,
} from "../channels/gateway-guardian-requests.js";
import { getGuardianRequestOrNull } from "../channels/gateway-guardian-requests.js";
import { findContactChannel } from "../contacts/contact-store.js";
import { findConversation } from "../daemon/conversation-registry.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  isNotificationSourceChannel,
  type NotificationSourceChannel,
} from "../notifications/signal.js";
import type {
  TrustedContactDecisionPayload,
  TrustedContactVerificationSentPayload,
} from "../notifications/trusted-contact-payloads.js";
import type { UserDecision } from "../permissions/types.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import {
  type ApprovalAction,
  DENYING_ACTION_SET,
} from "../runtime/channel-approval-types.js";
import { deliverChannelReply } from "../runtime/gateway-client.js";
import {
  introductionMode,
  parseRequesterSignals,
  type RequesterIdentitySignals,
  resolveTrustBinding,
} from "../runtime/introduction-policy.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { TC_GRANT_WAIT_MAX_MS } from "../tools/tool-approval-handler.js";
import { getLogger } from "../util/logger.js";
import { resolveDeliverCallbackUrlForChannel } from "./guardian-channel-delivery.js";

const log = getLogger("guardian-request-resolvers");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determines whether a Slack delivery should use ephemeral mode.
 *
 * Ephemeral messages (`chat.postEphemeral`) require a real channel ID
 * (starts with `C` for public/private channels, or `D` for DM conversations).
 * When the chat ID is a user ID (starts with `U`), `chat.postEphemeral` fails
 * with `channel_not_found`. In that case the message is already going to a DM
 * opened by `chat.postMessage`, so ephemeral isn't needed.
 *
 * Returns `true` only when the source channel is Slack AND the chatId is a
 * shared channel (starts with `C`), meaning other users could see the message.
 */
function shouldUseEphemeral(sourceChannel: string, chatId: string): boolean {
  return sourceChannel === "slack" && chatId.startsWith("C");
}

/**
 * Strip the `threadTs` query param from a reply callback URL. The param
 * addresses the guardian's channel thread; reusing it for a DM delivery
 * raises `thread_not_found`. Relative or malformed URLs are returned as-is —
 * they carry no threadTs to strip.
 */
function stripThreadTsParam(replyCallbackUrl: string): string {
  try {
    const url = new URL(replyCallbackUrl);
    url.searchParams.delete("threadTs");
    return url.toString();
  } catch {
    return replyCallbackUrl;
  }
}

/**
 * Deliver the verification code straight to the requester's Slack DM so the
 * guardian is never an out-of-band courier for the secret.
 *
 * Slack is the only channel with a guaranteed private path to the requester:
 * posting to their user ID (`U…`) opens a 1:1 DM. The `threadTs` query param is
 * dropped because it points at the guardian's channel thread and would raise
 * `thread_not_found` in the DM. The code is sent as a durable (non-ephemeral)
 * message the requester can refer back to when verifying.
 *
 * The verification session is identity-bound to the requester, so delivering
 * the code to them directly does not widen who can consume it — it only removes
 * the guardian relay step.
 *
 * Returns whether the code was delivered.
 */
async function deliverVerificationCodeToSlackRequester(params: {
  replyCallbackUrl: string;
  requesterExternalUserId: string;
  verificationCode: string;
  assistantId: string;
}): Promise<boolean> {
  const callbackUrl = stripThreadTsParam(params.replyCallbackUrl);

  try {
    await deliverChannelReply(callbackUrl, {
      chatId: params.requesterExternalUserId,
      text:
        "Great news — your access request was approved! " +
        `Your verification code is: \`${params.verificationCode}\`. ` +
        "Reply with it here to complete verification. The code expires in 10 minutes.",
      assistantId: params.assistantId,
    });
    return true;
  } catch (err) {
    log.error(
      { err, requesterExternalUserId: params.requesterExternalUserId },
      "Failed to auto-deliver verification code to Slack requester",
    );
    return false;
  }
}

/**
 * Build a requester-facing channel notice (approval/denial/courier text).
 *
 * Posts to the originating chat. On a Slack shared channel it goes out as an
 * ephemeral message visible only to the requester — and because
 * `chat.postEphemeral` needs a channel ID, `chatId` stays the channel
 * (`requesterChatId`), never the requester's `U…` user ID.
 */
function buildRequesterChannelNotice(params: {
  channel: string;
  requesterChatId: string;
  requesterExternalUserId: string;
  text: string;
  assistantId: string;
}): Parameters<typeof deliverChannelReply>[1] {
  const payload: Parameters<typeof deliverChannelReply>[1] = {
    chatId: params.requesterChatId,
    text: params.text,
    assistantId: params.assistantId,
  };
  if (
    shouldUseEphemeral(params.channel, params.requesterChatId) &&
    params.requesterExternalUserId
  ) {
    payload.ephemeral = true;
    payload.user = params.requesterExternalUserId;
  }
  return payload;
}

/**
 * Emit the `verification_sent` lifecycle signal on guardian approve.
 *
 * Always `visibleInSourceNow: true` so the notification pipeline suppresses
 * delivery — the guardian already received the code (on-channel via the channel
 * reply, off-channel via the inline reply text), so this records the lifecycle
 * transition without sending a redundant "approved" message. It also stands in
 * for `guardian_decision` on approve (which would notify), so the pipeline
 * doesn't announce approval before verification.
 */
function emitVerificationSentSignal(
  payload: TrustedContactVerificationSentPayload,
  conversationId: string | null | undefined,
): void {
  void emitNotificationSignal({
    sourceEventName: "ingress.trusted_contact.verification_sent",
    sourceChannel: payload.sourceChannel,
    sourceContextId: conversationId ?? "",
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: true,
    },
    contextPayload: payload,
    dedupeKey: `trusted-contact:verification-sent:${payload.verificationSessionId}`,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Actor context for the entity making the decision. */
export interface ActorContext {
  /** Auth-identity principal ID of the deciding actor (undefined for callback-only actors). */
  actorPrincipalId: string | undefined;
  /** Channel-native external user ID (Telegram user ID, E.164 phone, etc.) of the deciding actor (undefined for desktop actors). Maps to `decided_by_external_user_id` DB column. */
  actorExternalUserId: string | undefined;
  /** Channel the decision arrived on. */
  channel: string;
  /** Principal ID for authorization — must match the request's guardianPrincipalId. */
  guardianPrincipalId: string | undefined;
}

/** The decision being applied. */
export interface ResolverDecision {
  /** The effective action (approve_once or reject). */
  action: ApprovalAction;
  /** Optional user-supplied text (e.g. answer text for pending questions). */
  userText?: string;
}

/** Channel delivery context for resolvers that need to send messages. */
export interface ChannelDeliveryContext {
  /** URL to POST channel replies to. */
  replyCallbackUrl: string;
  /** Chat ID of the guardian receiving the reply. */
  guardianChatId: string;
  /** Assistant ID for attribution. */
  assistantId: string;
  /** Optional bearer token for authenticated delivery. */
  bearerToken?: string;
}

/** Emission context threaded from callers to handleConfirmationResponse. */
export interface ResolverEmissionContext {
  source?: "button" | "inline_nl" | "auto_deny" | "timeout" | "system";
  causedByRequestId?: string;
  decisionText?: string;
}

/** Context passed to a resolver's `prepare`, before any status write. */
export interface PrepareContext {
  /** The guardian request, still pending. */
  request: GuardianRequestWire;
  /** The decision being applied. */
  decision: ResolverDecision;
  /** Actor context for the entity making the decision. */
  actor: ActorContext;
}

/**
 * Outcome plan a resolver produces before the decision commits.
 *
 * `aclOutcome` (when present) is committed by the gateway in the SAME
 * transaction as the status CAS. `persistFailureReason` becomes the
 * `resolverFailureReason` surfaced to callers when the atomic decide throws —
 * the request stays pending gateway-side and the guardian can retry.
 * `ok: false` aborts the decision before any status write.
 */
export type DecisionOutcomePlan =
  | {
      ok: true;
      aclOutcome?: GuardianRequestAclOutcome;
      persistFailureReason: string;
    }
  | { ok: false; reason: string };

/** Context passed to each resolver after the atomic decide succeeds. */
export interface ResolverContext {
  /** The guardian request record (already resolved to its terminal status). */
  request: GuardianRequestWire;
  /** The decision being applied. */
  decision: ResolverDecision;
  /** Actor context for the entity making the decision. */
  actor: ActorContext;
  /** Optional channel delivery context — present when the decision arrived via a channel message. */
  channelDeliveryContext?: ChannelDeliveryContext;
  /** Optional emission context threaded to handleConfirmationResponse for correct source attribution. */
  emissionContext?: ResolverEmissionContext;
  /**
   * Raw outbound-session mint returned by the atomic decide when the planned
   * outcome was `mint_outbound_session` — the secret transits back for
   * daemon-owned code delivery.
   */
  mintedSession?: CreateOutboundSessionIpcResponse;
}

/** Discriminated result from a resolver. */
export type ResolverResult =
  | {
      ok: true;
      applied: true;
      grantMinted?: boolean;
      guardianReplyText?: string;
    }
  | { ok: false; reason: string };

/** Interface that kind-specific resolvers implement. */
export interface GuardianRequestResolver {
  /** The request kind this resolver handles (matches guardian_requests.kind). */
  kind: string;
  /**
   * Plan the gateway ACL outcome for this decision, BEFORE any status write.
   * Kinds without gateway-owned outcomes omit this — their decide is a plain
   * status CAS.
   */
  prepare?(context: PrepareContext): DecisionOutcomePlan;
  /** Execute daemon-domain follow-through after the atomic decide commits. */
  resolve(context: ResolverContext): Promise<ResolverResult>;
}

// ---------------------------------------------------------------------------
// Resolver implementations
// ---------------------------------------------------------------------------

/**
 * Resolves `tool_approval` requests — the channel/desktop approval path.
 *
 * Adapts the existing `handleChannelDecision` logic: looks up the pending
 * interaction by conversation ID, maps the decision to the session's
 * confirmation response, and resolves the interaction.
 *
 * Side effects are deferred to callers that wire into existing channel
 * approval infrastructure.  This resolver focuses on validating that the
 * request shape is appropriate for tool_approval handling.
 */
const pendingInteractionResolver: GuardianRequestResolver = {
  kind: "tool_approval",

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision } = ctx;

    if (!request.sourceConversationId) {
      return {
        ok: false,
        reason: "tool_approval request missing conversationId",
      };
    }

    // Look up the pending interaction directly by requestId.
    const interaction = pendingInteractions.get(request.id);
    if (!interaction) {
      // The pending interaction was already consumed (stale) or not found.
      // The decision CAS already committed, so this is not an error — just
      // means the interaction was resolved by another path (e.g. timeout).
      log.warn(
        {
          event: "resolver_tool_approval_stale",
          requestId: request.id,
          conversationId: request.sourceConversationId,
        },
        "Tool approval resolver: pending interaction not found (already consumed or timed out)",
      );
      return { ok: false, reason: "pending_interaction_not_found" };
    }

    // Map action to the permission system's UserDecision type and notify session.
    // resolveConfirmation() owns pendingInteractions deregistration.
    const userDecision: UserDecision = DENYING_ACTION_SET.has(decision.action)
      ? "deny"
      : "allow";

    // Route-owned confirmations (e.g. the ACP spawn/steer approval gate in
    // acp-routes.ts) carry a `directResolve` and are NOT owned by any
    // Conversation.prompter, so handleConfirmationResponse below would no-op
    // and the caller would block until timeout. Resolve them directly, exactly
    // as the POST /v1/confirm route does (see approval-routes.ts).
    if (interaction.directResolve) {
      pendingInteractions.resolve(
        request.id,
        userDecision === "allow" ? "approved" : "rejected",
      );
      interaction.directResolve(userDecision);
      log.info(
        {
          event: "resolver_tool_approval_applied",
          requestId: request.id,
          action: decision.action,
          conversationId: request.sourceConversationId,
          toolName: request.toolName,
          directResolve: true,
        },
        "Tool approval resolver: direct-resolve interaction resolved",
      );
      return { ok: true, applied: true };
    }

    const conversation = findConversation(interaction.conversationId);
    if (!conversation) {
      return {
        ok: false,
        reason: `conversation_not_found: ${interaction.conversationId}`,
      };
    }
    conversation.handleConfirmationResponse(request.id, userDecision, {
      emissionContext: ctx.emissionContext,
    });

    log.info(
      {
        event: "resolver_tool_approval_applied",
        requestId: request.id,
        action: decision.action,
        conversationId: request.sourceConversationId,
        toolName: request.toolName,
      },
      "Tool approval resolver: pending interaction resolved",
    );

    return { ok: true, applied: true };
  },
};

/**
 * Resolves `pending_question` requests — the voice call question path.
 *
 * Validates that voice-specific fields (callSessionId, pendingQuestionId)
 * are present and delivers the answer to the live call session. An
 * `answerCall` failure surfaces as `resolverFailed` — the committed decision
 * stands (no reopen).
 */
const pendingQuestionResolver: GuardianRequestResolver = {
  kind: "pending_question",

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision, actor: _actor } = ctx;

    if (!request.callSessionId) {
      return {
        ok: false,
        reason: "pending_question request missing callSessionId",
      };
    }

    if (!request.pendingQuestionId) {
      return {
        ok: false,
        reason: "pending_question request missing pendingQuestionId",
      };
    }

    // Derive the answer text from the decision. For approve actions, use the
    // guardian's text if present; otherwise use a default affirmative answer.
    // For reject, use the text or a default denial.
    const answerText =
      decision.userText ?? (decision.action === "reject" ? "No" : "Yes");

    // 1. Deliver the answer to the voice call session.
    const answerResult = await answerCall({
      callSessionId: request.callSessionId,
      answer: answerText,
      pendingQuestionId: request.pendingQuestionId,
    });

    if (!("ok" in answerResult) || !answerResult.ok) {
      const errorMsg =
        "error" in answerResult ? answerResult.error : "Unknown error";
      log.warn(
        {
          event: "resolver_pending_question_answer_failed",
          requestId: request.id,
          callSessionId: request.callSessionId,
          error: errorMsg,
        },
        "Pending question resolver: answerCall failed",
      );
      // The decision CAS has already committed so we don't roll back the
      // resolution, but we signal failure so the decision primitive skips
      // grant minting and callers see the side-effect failure.
      return { ok: false, reason: "answer_call_failed" };
    }

    log.info(
      {
        event: "resolver_pending_question_applied",
        requestId: request.id,
        action: decision.action,
        callSessionId: request.callSessionId,
        pendingQuestionId: request.pendingQuestionId,
        answerText,
        answerCallOk:
          "ok" in (answerResult as Record<string, unknown>)
            ? (answerResult as Record<string, unknown>).ok
            : false,
      },
      "Pending question resolver: decision applied",
    );

    return { ok: true, applied: true };
  },
};

/**
 * The four introduction-card outcomes for an access request. The generic
 * decision pair maps onto them: `approve_once` → `verify_code` (handshake),
 * `reject` → `leave_unverified`.
 */
type IntroductionOutcome =
  | "verify_code"
  | "trust"
  | "leave_unverified"
  | "block";

/**
 * Wire action → introduction outcome. Exhaustive over `ApprovalAction` so a
 * future action addition fails to compile here instead of silently falling
 * into a default outcome.
 */
const OUTCOME_BY_ACTION = {
  approve_once: "verify_code",
  verify_code: "verify_code",
  trust: "trust",
  reject: "leave_unverified",
  leave_unverified: "leave_unverified",
  block: "block",
} as const satisfies Record<ApprovalAction, IntroductionOutcome>;

/** Derived access-request decision facts shared by `prepare` and `resolve`. */
interface AccessRequestDerivation {
  channel: NotificationSourceChannel;
  requesterExternalUserId: string;
  requesterChatId: string;
  requesterDisplayName: string | null;
  signals: RequesterIdentitySignals;
  outcome: IntroductionOutcome;
}

/**
 * Derive the effective introduction outcome and requester identity facts for
 * an access-request decision. Pure over the request row + action, so
 * `prepare` (outcome planning) and `resolve` (follow-through) branch
 * identically.
 */
function deriveAccessRequestDecision(
  request: GuardianRequestWire,
  action: ApprovalAction,
): AccessRequestDerivation {
  const channel: NotificationSourceChannel = isNotificationSourceChannel(
    request.sourceChannel,
  )
    ? request.sourceChannel
    : "vellum";
  const requesterExternalUserId = request.requesterExternalUserId ?? "";
  const requesterChatId =
    request.requesterChatId ?? request.requesterExternalUserId ?? "";

  // Resolve display names from the contacts database for enriched payloads
  const requesterContactResult = requesterExternalUserId
    ? findContactChannel({
        channelType: channel,
        address: requesterExternalUserId,
      })
    : null;
  const requesterDisplayName =
    requesterContactResult?.contact.displayName ?? null;

  const signals = parseRequesterSignals(request.requesterSignals);
  let outcome: IntroductionOutcome = OUTCOME_BY_ACTION[action];

  // A bot cannot return a verification code, so a handshake approval on a
  // bot requester can never complete. Coerce it to direct trust — the
  // guardian's intent ("let it in") is unambiguous. Logged once, in
  // `prepare` (this derivation runs again in `resolve`).
  if (outcome === "verify_code" && signals.isBot === true) {
    outcome = "trust";
  }

  return {
    channel,
    requesterExternalUserId,
    requesterChatId,
    requesterDisplayName,
    signals,
    outcome,
  };
}

/**
 * Deliver a requester-facing decision notice. On-channel decisions reply via
 * the channel delivery context (ephemeral on Slack shared channels);
 * off-channel (desktop) decisions post via the channel's deliver URL — on
 * Slack routed to the requester's user ID so the notice opens a DM instead
 * of posting into a shared channel. Delivery failures are logged, never
 * thrown: the notice is best-effort and must not fail the decision.
 */
async function deliverRequesterNotice(params: {
  channel: NotificationSourceChannel;
  requesterChatId: string;
  requesterExternalUserId: string;
  assistantId: string;
  channelDeliveryContext: ChannelDeliveryContext | undefined;
  desktopDeliverUrl: string | null;
  text: string;
}): Promise<void> {
  const {
    channel,
    requesterChatId,
    requesterExternalUserId,
    assistantId,
    channelDeliveryContext,
    desktopDeliverUrl,
    text,
  } = params;

  if (channelDeliveryContext) {
    try {
      await deliverChannelReply(
        channelDeliveryContext.replyCallbackUrl,
        buildRequesterChannelNotice({
          channel,
          requesterChatId,
          requesterExternalUserId,
          text,
          assistantId,
        }),
      );
    } catch (err) {
      log.error(
        { err, requesterChatId },
        "Failed to deliver requester decision notice",
      );
    }
    return;
  }

  if (desktopDeliverUrl && requesterChatId) {
    const targetChatId =
      channel === "slack" && requesterExternalUserId
        ? requesterExternalUserId
        : requesterChatId;
    try {
      await deliverChannelReply(desktopDeliverUrl, {
        chatId: targetChatId,
        text,
        assistantId,
      });
    } catch (err) {
      log.error(
        { err, requesterChatId },
        "Failed to deliver requester decision notice (desktop decision path)",
      );
    }
  }
}

/**
 * Deliver the "denied" notice to the requester and emit the denial lifecycle
 * signals. Shared by the `leave_unverified` and `block` outcomes — both look
 * identical to the requester (the block is not revealed).
 */
async function notifyRequesterOfDenial(params: {
  channel: NotificationSourceChannel;
  requesterChatId: string;
  requesterExternalUserId: string;
  assistantId: string;
  channelDeliveryContext: ChannelDeliveryContext | undefined;
  desktopDeliverUrl: string | null;
  deniedPayload: TrustedContactDecisionPayload;
  requestId: string;
  conversationId: string | null;
  /**
   * Admitted-mode introduction nudges never send the requester a denial
   * text — the sender made no request and (for leave-unverified) keeps
   * whatever access the floor grants. Guardian-facing decision signals
   * still emit.
   */
  suppressRequesterNotice?: boolean;
}): Promise<void> {
  const {
    channel,
    requesterChatId,
    requesterExternalUserId,
    assistantId,
    channelDeliveryContext,
    desktopDeliverUrl,
    deniedPayload,
    requestId,
    conversationId,
    suppressRequesterNotice,
  } = params;

  if (!suppressRequesterNotice) {
    await deliverRequesterNotice({
      channel,
      requesterChatId,
      requesterExternalUserId,
      assistantId,
      channelDeliveryContext,
      desktopDeliverUrl,
      text: "Your access request has been denied.",
    });
  }

  if (channelDeliveryContext) {
    void emitNotificationSignal({
      sourceEventName: "ingress.trusted_contact.guardian_decision",
      sourceChannel: channel,
      sourceContextId: conversationId ?? "",
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: deniedPayload,
      dedupeKey: `trusted-contact:guardian-decision:${requestId}`,
    });

    void emitNotificationSignal({
      sourceEventName: "ingress.trusted_contact.denied",
      sourceChannel: channel,
      sourceContextId: conversationId ?? "",
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: deniedPayload,
      dedupeKey: `trusted-contact:denied:${requestId}`,
    });
  }
}

/**
 * Resolves `access_request` requests — the introduction card's trust-setting
 * decision for a first-contact sender.
 *
 * Four outcomes (see `introduction-policy.ts`):
 * - `verify_code` (also reached via `approve_once`): mints an identity-bound
 *   verification session so the requester proves control of the channel.
 * - `trust`: activates the contact directly, no code. `verifiedVia` records
 *   the binding strength: `manual` for a workspace-vouched identity,
 *   `manual_channel_claim` for an external/stranger the platform is not
 *   vouching for.
 * - `leave_unverified` (also reached via `reject`): persists the sender as an
 *   `unverified_contact` so discovery does not re-fire.
 * - `block`: persists the sender's channel as `revoked` (gateway ACL is the
 *   source of truth).
 *
 * `prepare` maps the outcome onto the gateway `aclOutcome` committed
 * atomically with the status CAS; `resolve` runs the daemon-domain
 * follow-through (requester/guardian notices, verification-code delivery
 * from the decide's `mintedSession`, lifecycle signals).
 *
 * A bot requester can never return a code, so handshake approvals are
 * coerced to direct trust.
 */
const accessRequestResolver: GuardianRequestResolver = {
  kind: "access_request",

  prepare(ctx: PrepareContext): DecisionOutcomePlan {
    const { request, decision } = ctx;
    const {
      channel,
      requesterExternalUserId,
      requesterChatId,
      requesterDisplayName,
      signals,
      outcome,
    } = deriveAccessRequestDecision(request, decision.action);

    if (outcome !== OUTCOME_BY_ACTION[decision.action]) {
      log.info(
        {
          event: "resolver_access_request_bot_coercion",
          requestId: request.id,
          action: decision.action,
        },
        "Access request resolver: handshake approval on a bot coerced to direct trust",
      );
    }

    if (outcome === "leave_unverified") {
      // Persist the denied sender as an unverified_contact so future inbound
      // resolves as unverified_contact rather than re-triggering discovery.
      // Skipped for desktop-origin (vellum) requests, which carry no channel
      // identity — those deny as a plain status CAS.
      if (!requesterExternalUserId || channel === "vellum") {
        return { ok: true, persistFailureReason: "decision_persist_failed" };
      }
      return {
        ok: true,
        aclOutcome: {
          type: "seed_unverified",
          sourceChannel: channel,
          externalUserId: requesterExternalUserId,
          ...(requesterDisplayName
            ? { displayName: requesterDisplayName }
            : {}),
        },
        persistFailureReason: "seed_unverified_failed",
      };
    }

    if (outcome === "block") {
      if (!requesterExternalUserId || channel === "vellum") {
        // No channel identity to revoke — nothing can land on the gateway,
        // so the decision is aborted before any status write.
        return { ok: false, reason: "block_missing_channel_identity" };
      }
      return {
        ok: true,
        aclOutcome: {
          type: "block",
          sourceChannel: channel,
          externalUserId: requesterExternalUserId,
          ...(requesterDisplayName
            ? { displayName: requesterDisplayName }
            : {}),
          reason: "introduction_block",
        },
        persistFailureReason: "block_persist_failed",
      };
    }

    // Voice approvals: directly activate the trusted contact without minting
    // a verification session. The caller is already on the line and the
    // call setup flow's in-call wait loop will detect the approved status.
    // The gateway fails the decide closed when the row carries no channel
    // identity — a caller the ACL source of truth never verified must not
    // resolve as approved.
    if (channel === "phone") {
      return {
        ok: true,
        aclOutcome: {
          type: "activate_member",
          sourceChannel: "phone",
          ...(requesterExternalUserId
            ? { externalUserId: requesterExternalUserId }
            : {}),
          ...(requesterChatId ? { externalChatId: requesterChatId } : {}),
        },
        persistFailureReason: "voice_activation_failed",
      };
    }

    // Direct trust: activate the contact without a handshake. The binding
    // strength is derived from the platform's identity signals — a
    // workspace-vouched identity records `manual` (internal_workspace_match);
    // an external/stranger records `manual_channel_claim`
    // (inbound_channel_claim), never handshake-equivalent provenance.
    if (outcome === "trust") {
      // A trust without a channel identity cannot land on the gateway ACL —
      // fail closed before any status write, mirroring the block guard.
      if (!requesterExternalUserId || channel === "vellum") {
        return { ok: false, reason: "trust_missing_channel_identity" };
      }
      const binding = resolveTrustBinding(channel, signals);
      return {
        ok: true,
        aclOutcome: {
          type: "activate_member",
          sourceChannel: channel,
          externalUserId: requesterExternalUserId,
          externalChatId: requesterChatId,
          ...(requesterDisplayName
            ? { displayName: requesterDisplayName }
            : {}),
          verifiedVia: binding.verifiedVia,
        },
        persistFailureReason: "trust_activation_failed",
      };
    }

    // Non-voice approvals: mint an identity-bound verification session so the
    // requester can verify their identity. The raw secret transits back on
    // the decide response for daemon-owned delivery.
    return {
      ok: true,
      aclOutcome: {
        type: "mint_outbound_session",
        channel,
        expectedExternalUserId: requesterExternalUserId,
        expectedChatId: requesterChatId,
        identityBindingStatus: "bound",
        destinationAddress: requesterChatId,
        verificationPurpose: "trusted_contact",
      },
      persistFailureReason: "verification_session_mint_failed",
    };
  },

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision, channelDeliveryContext } = ctx;
    const {
      channel,
      requesterExternalUserId,
      requesterChatId,
      requesterDisplayName,
      outcome,
    } = deriveAccessRequestDecision(request, decision.action);
    const decidedByExternalUserId = ctx.actor.actorExternalUserId ?? "";
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
    const desktopDeliverUrl = resolveDeliverCallbackUrlForChannel(channel);

    // Guardian-facing label prefers the contact display name over the raw ID.
    const requesterLabel =
      requesterDisplayName ||
      requesterExternalUserId ||
      requesterChatId ||
      "the requester";

    const decidedByContactResult = decidedByExternalUserId
      ? findContactChannel({
          channelType: channel,
          address: decidedByExternalUserId,
        })
      : null;
    const decidedByDisplayName =
      decidedByContactResult?.contact.displayName ?? null;

    // Requester-facing lifecycle notices are mode-gated: an admitted-mode
    // nudge's sender made no request. See introductionMode().
    const mode = introductionMode(request.requestTrigger);

    const deniedPayload: TrustedContactDecisionPayload = {
      sourceChannel: channel,
      requesterExternalUserId,
      requesterChatId,
      decidedByExternalUserId,
      requesterDisplayName,
      decidedByDisplayName,
      decision: "denied",
    };

    if (outcome === "leave_unverified") {
      log.info(
        { event: "resolver_access_request_denied", requestId: request.id },
        "Access request resolver: leave unverified",
      );

      await notifyRequesterOfDenial({
        channel,
        requesterChatId,
        requesterExternalUserId,
        assistantId,
        channelDeliveryContext,
        desktopDeliverUrl,
        deniedPayload,
        requestId: request.id,
        conversationId: request.sourceConversationId,
        suppressRequesterNotice: !mode.notifyRequesterOnDeny,
      });

      return {
        ok: true,
        applied: true,
        // Desktop actors (vellum channel) receive inline reply text; channel
        // actors get replies delivered via the channel delivery context. An
        // admitted sender keeps whatever access the floor grants.
        ...(ctx.actor.channel === "vellum"
          ? {
              guardianReplyText:
                mode.leaveUnverifiedGuardianReply(requesterLabel),
            }
          : {}),
      };
    }

    if (outcome === "block") {
      log.info(
        { event: "resolver_access_request_blocked", requestId: request.id },
        "Access request resolver: block",
      );

      // The requester sees the same denial notice as leave-unverified — the
      // block itself is not revealed.
      await notifyRequesterOfDenial({
        channel,
        requesterChatId,
        requesterExternalUserId,
        assistantId,
        channelDeliveryContext,
        desktopDeliverUrl,
        deniedPayload,
        requestId: request.id,
        conversationId: request.sourceConversationId,
        suppressRequesterNotice: !mode.notifyRequesterOnDeny,
      });

      return {
        ok: true,
        applied: true,
        ...(ctx.actor.channel === "vellum"
          ? {
              guardianReplyText: `Blocked ${requesterLabel}. Their messages will no longer reach the assistant.`,
            }
          : {}),
      };
    }

    // Voice approvals: the caller was activated atomically with the decide;
    // the call setup flow's in-call wait loop detects the approved status.
    if (channel === "phone") {
      log.info(
        {
          event: "resolver_access_request_voice_approved",
          requestId: request.id,
          channel,
          requesterExternalUserId,
        },
        "Access request resolver: voice approval — direct trusted-contact activation (no verification session)",
      );

      return { ok: true, applied: true };
    }

    if (outcome === "trust") {
      log.info(
        {
          event: "resolver_access_request_trusted",
          requestId: request.id,
          channel,
          requesterExternalUserId,
        },
        "Access request resolver: direct trust — contact activated without handshake",
      );

      // Notify the requester they're in. Admitted-mode nudges skip this —
      // the sender was already conversing and made no request.
      if (mode.notifyRequesterOnTrust) {
        await deliverRequesterNotice({
          channel,
          requesterChatId,
          requesterExternalUserId,
          assistantId,
          channelDeliveryContext,
          desktopDeliverUrl,
          text: "Your access request has been approved. You can message the assistant here.",
        });
      }

      return {
        ok: true,
        applied: true,
        ...(ctx.actor.channel === "vellum"
          ? {
              guardianReplyText: `Trusted ${requesterLabel}. They can now message the assistant — no verification code needed.`,
            }
          : {}),
      };
    }

    // Non-voice approvals: the identity-bound verification session was minted
    // atomically with the decide; its raw secret arrives via `mintedSession`.
    const session = ctx.mintedSession;
    if (!session) {
      log.error(
        { event: "resolver_access_request_missing_mint", requestId: request.id },
        "Access request resolver: decide returned no mintedSession for a verify_code outcome",
      );
      return { ok: false, reason: "minted_session_missing" };
    }

    log.info(
      {
        event: "resolver_access_request_approved",
        requestId: request.id,
        verificationSessionId: session.sessionId,
        channel,
        requesterExternalUserId,
      },
      "Access request resolver: minted verification session",
    );

    // Deliver the verification code to the guardian and notify the requester
    // when channel delivery context is available (channel message path).
    let requesterNotified = false;
    if (channelDeliveryContext) {
      let codeDelivered = true;

      // Deliver verification code to guardian
      const codeText =
        `You approved access for ${requesterLabel}. ` +
        `Give them this verification code: \`${session.secret}\`. ` +
        `The code expires in 10 minutes.`;
      try {
        const codePayload: Parameters<typeof deliverChannelReply>[1] = {
          chatId: channelDeliveryContext.guardianChatId,
          text: codeText,
          assistantId,
        };
        // On Slack shared channels, deliver the verification code as ephemeral
        // so only the guardian sees the secret — not all channel members.
        if (
          shouldUseEphemeral(channel, channelDeliveryContext.guardianChatId) &&
          ctx.actor.actorExternalUserId
        ) {
          codePayload.ephemeral = true;
          codePayload.user = ctx.actor.actorExternalUserId;
        }
        await deliverChannelReply(
          channelDeliveryContext.replyCallbackUrl,
          codePayload,
        );
      } catch (err) {
        log.error(
          { err, guardianChatId: channelDeliveryContext.guardianChatId },
          "Failed to deliver verification code to guardian",
        );
        codeDelivered = false;
      }

      // If the guardian approved in a shared channel (not a DM), also send
      // them a DM with the verification code for better privacy and
      // discoverability. On Slack, posting to a user ID opens a DM.
      const guardianUserId = ctx.actor.actorExternalUserId;
      if (
        codeDelivered &&
        channel === "slack" &&
        guardianUserId &&
        !channelDeliveryContext.guardianChatId.startsWith("D")
      ) {
        const dmCallbackUrl = stripThreadTsParam(
          channelDeliveryContext.replyCallbackUrl,
        );

        try {
          await deliverChannelReply(dmCallbackUrl, {
            chatId: guardianUserId,
            text: codeText,
            assistantId,
          });
        } catch (err) {
          // Best-effort: the code was already delivered in the shared channel
          log.warn(
            { err, guardianUserId },
            "Failed to send guardian DM confirmation with verification code",
          );
        }
      }

      const requesterCallbackUrl =
        channel === "slack" && requesterExternalUserId
          ? stripThreadTsParam(channelDeliveryContext.replyCallbackUrl)
          : channelDeliveryContext.replyCallbackUrl;

      if (codeDelivered) {
        // On Slack, deliver the code straight to the requester's DM so the
        // guardian doesn't have to relay it. Other channels (and a failed Slack
        // delivery) fall back to the courier notice — there is no guaranteed
        // private path to the requester elsewhere (e.g. group chats).
        const requesterCodeDelivered =
          channel === "slack" && requesterExternalUserId
            ? await deliverVerificationCodeToSlackRequester({
                replyCallbackUrl: channelDeliveryContext.replyCallbackUrl,
                requesterExternalUserId,
                verificationCode: session.secret,
                assistantId,
              })
            : false;

        if (requesterCodeDelivered) {
          requesterNotified = true;
        } else {
          try {
            await deliverChannelReply(
              requesterCallbackUrl,
              buildRequesterChannelNotice({
                channel,
                requesterChatId,
                requesterExternalUserId,
                text:
                  "Your access request has been approved! " +
                  "Please enter the 6-digit verification code you receive from the guardian.",
                assistantId,
              }),
            );
            requesterNotified = true;
          } catch (err) {
            log.error(
              { err, requesterChatId },
              "Failed to notify requester of access request approval",
            );
          }
        }
      } else {
        try {
          await deliverChannelReply(
            requesterCallbackUrl,
            buildRequesterChannelNotice({
              channel,
              requesterChatId,
              requesterExternalUserId,
              text:
                "Your access request was approved, but we were unable to " +
                "deliver the verification code. Please try again later.",
              assistantId,
            }),
          );
        } catch (err) {
          log.error(
            { err, requesterChatId },
            "Failed to notify requester of delivery failure",
          );
        }
      }

      // Record the verification_sent lifecycle transition (delivery suppressed).
      if (codeDelivered) {
        emitVerificationSentSignal(
          {
            sourceChannel: channel,
            requesterExternalUserId,
            requesterChatId,
            requesterDisplayName,
            decidedByDisplayName,
            verificationSessionId: session.sessionId,
          },
          request.sourceConversationId,
        );
      }
    } else {
      // Guardian decided off-channel (e.g. desktop). The guardian receives the
      // verification code inline via `guardianReplyText` regardless of the
      // requester's channel, so the lifecycle transition is recorded for every
      // off-channel approve — including channels with no deliverable callback
      // (e.g. email), where the requester cannot be auto-notified here.
      if (desktopDeliverUrl && requesterChatId) {
        // The requester is on a deliverable channel. On Slack, DM the code
        // directly (parity with the on-channel path); otherwise fall back to
        // the courier notice.
        const requesterCodeDelivered =
          channel === "slack" && requesterExternalUserId
            ? await deliverVerificationCodeToSlackRequester({
                replyCallbackUrl: desktopDeliverUrl,
                requesterExternalUserId,
                verificationCode: session.secret,
                assistantId,
              })
            : false;

        if (requesterCodeDelivered) {
          requesterNotified = true;
        } else {
          // For Slack, route to DM via requesterExternalUserId (user ID)
          // instead of requesterChatId (channel ID) to avoid posting in public
          // channels.
          const targetChatId =
            channel === "slack" && requesterExternalUserId
              ? requesterExternalUserId
              : requesterChatId;
          try {
            await deliverChannelReply(desktopDeliverUrl, {
              chatId: targetChatId,
              text:
                "Your access request has been approved! " +
                "Please enter the 6-digit verification code you receive from the guardian.",
              assistantId,
            });
            requesterNotified = true;
          } catch (err) {
            log.error(
              { err, requesterChatId },
              "Failed to notify requester of access request approval (desktop decision path)",
            );
          }
        }
      }

      // Record the verification_sent lifecycle transition for every off-channel
      // approve. The session is minted and the guardian has the code via
      // `guardianReplyText` regardless of whether (or how) the requester was
      // notified — mirroring the on-channel branch, which keys off guardian
      // receipt rather than requester delivery. Without this, approves on
      // channels with no deliverable callback (e.g. email) would silently skip
      // the audit/lifecycle record.
      emitVerificationSentSignal(
        {
          sourceChannel: channel,
          requesterExternalUserId,
          requesterChatId,
          requesterDisplayName,
          decidedByDisplayName,
          verificationSessionId: session.sessionId,
        },
        request.sourceConversationId,
      );
    }

    const verificationReplyText = requesterNotified
      ? `Access approved for ${requesterLabel}. Give them this verification code: \`${session.secret}\`. The code expires in 10 minutes.`
      : `Access approved for ${requesterLabel}. Give them this verification code: \`${session.secret}\`. The code expires in 10 minutes. I could not notify them automatically, so please tell them to send the code manually.`;

    return {
      ok: true,
      applied: true,
      // Desktop actors (vellum channel) receive inline reply text; channel
      // actors get replies delivered via the channel delivery context.
      ...(ctx.actor.channel === "vellum"
        ? { guardianReplyText: verificationReplyText }
        : {}),
    };
  },
};

/**
 * Resolves `tool_grant_request` requests — asynchronous grant escalation for
 * non-guardian channel actors.
 *
 * Unlike `tool_approval`, this kind does NOT require a pending interaction in
 * the session tracker. The request represents an async escalation: the
 * requester's tool call was already denied, and the guardian request exists
 * solely so the guardian can mint a scoped grant.
 *
 * On approve: the decision primitive mints the grant (after this resolver
 * runs). This resolver optionally notifies the requester to retry.
 *
 * On reject: optionally notifies the requester that their request was denied.
 */
const toolGrantRequestResolver: GuardianRequestResolver = {
  kind: "tool_grant_request",

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision, channelDeliveryContext } = ctx;
    const requesterChatId =
      request.requesterChatId ?? request.requesterExternalUserId ?? "";
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;

    if (decision.action === "reject") {
      log.info(
        {
          event: "resolver_tool_grant_request_denied",
          requestId: request.id,
          toolName: request.toolName,
        },
        "Tool grant request resolver: deny",
      );

      if (channelDeliveryContext && requesterChatId) {
        try {
          const grantDenialPayload: Parameters<typeof deliverChannelReply>[1] =
            {
              chatId: requesterChatId,
              text: `Your request to use "${request.toolName}" has been denied by the guardian.`,
              assistantId,
            };
          if (
            shouldUseEphemeral(request.sourceChannel ?? "", requesterChatId) &&
            request.requesterExternalUserId
          ) {
            grantDenialPayload.ephemeral = true;
            grantDenialPayload.user = request.requesterExternalUserId;
          }
          await deliverChannelReply(
            channelDeliveryContext.replyCallbackUrl,
            grantDenialPayload,
          );
        } catch (err) {
          log.error(
            { err, requesterChatId },
            "Failed to notify requester of tool grant request denial",
          );
        }
      }

      return { ok: true, applied: true };
    }

    // On approve: grant minting is handled by the decision primitive after
    // this resolver runs. This resolver only handles requester notification.
    log.info(
      {
        event: "resolver_tool_grant_request_approved",
        requestId: request.id,
        toolName: request.toolName,
      },
      "Tool grant request resolver: approved (grant minting deferred to the decision primitive)",
    );

    // Re-read the guardian request to check whether an inline grant waiter
    // has already claimed this request. When followupState is
    // 'inline_wait_active', the requester's original tool call is blocking
    // on the grant and will resume automatically — sending a "please retry"
    // notification would be stale and confusing (and could cause duplicate
    // attempts or one-time-grant denials).
    //
    // Staleness guard: the inline_wait_active marker is persisted and can
    // outlive the actual waiter if the daemon crashes or restarts during
    // the wait. To avoid permanently suppressing the retry notification, we
    // treat the marker as stale if the encoded start timestamp is older than
    // the maximum wait budget plus a 30s buffer.
    const INLINE_WAIT_STALENESS_BUFFER_MS = 30_000;
    const freshRequest = await getGuardianRequestOrNull(request.id);
    const followupState = freshRequest?.followupState ?? "";
    let inlineWaitActive = followupState.startsWith("inline_wait_active");
    if (inlineWaitActive && freshRequest) {
      // The followupState encodes the wall-clock epoch when the inline wait
      // started (e.g. 'inline_wait_active:1700000000000'). We use this
      // instead of updatedAt because the decide CAS sets updatedAt = now,
      // making updatedAt always fresh by the time this resolver runs.
      const colonIdx = followupState.indexOf(":");
      const waitStartMs =
        colonIdx !== -1 ? Number(followupState.slice(colonIdx + 1)) : NaN;
      const markerAgeMs = Number.isFinite(waitStartMs)
        ? Date.now() - waitStartMs
        : Infinity; // Treat unparseable timestamps as stale for safety.
      const stalenessThresholdMs =
        TC_GRANT_WAIT_MAX_MS + INLINE_WAIT_STALENESS_BUFFER_MS;
      if (markerAgeMs > stalenessThresholdMs) {
        log.warn(
          {
            event: "resolver_tool_grant_request_stale_inline_wait",
            requestId: request.id,
            toolName: request.toolName,
            markerAgeMs,
            stalenessThresholdMs,
            waitStartMs,
          },
          "inline_wait_active marker is stale (daemon likely crashed during wait) — sending retry notification",
        );
        inlineWaitActive = false;
      }
    }

    if (inlineWaitActive) {
      log.info(
        {
          event: "resolver_tool_grant_request_skip_retry_notification",
          requestId: request.id,
          toolName: request.toolName,
          followupState: freshRequest?.followupState,
        },
        "Skipping requester retry notification — inline grant wait is active and will resume the original invocation",
      );
    } else if (channelDeliveryContext && requesterChatId) {
      try {
        const grantApprovalPayload: Parameters<typeof deliverChannelReply>[1] =
          {
            chatId: requesterChatId,
            text: `Your request to use "${request.toolName}" has been approved. Please retry your request.`,
            assistantId,
          };
        if (
          shouldUseEphemeral(request.sourceChannel ?? "", requesterChatId) &&
          request.requesterExternalUserId
        ) {
          grantApprovalPayload.ephemeral = true;
          grantApprovalPayload.user = request.requesterExternalUserId;
        }
        await deliverChannelReply(
          channelDeliveryContext.replyCallbackUrl,
          grantApprovalPayload,
        );
      } catch (err) {
        log.error(
          { err, requesterChatId },
          "Failed to notify requester of tool grant request approval",
        );
      }
    }

    return { ok: true, applied: true, grantMinted: false };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const resolverRegistry = new Map<string, GuardianRequestResolver>();

/** Register a resolver for a given request kind. */
function registerResolver(resolver: GuardianRequestResolver): void {
  resolverRegistry.set(resolver.kind, resolver);
}

/** Look up the resolver for a given request kind. */
export function getResolver(kind: string): GuardianRequestResolver | undefined {
  return resolverRegistry.get(kind);
}

/** Return all registered resolver kinds (for diagnostics). */
export function getRegisteredKinds(): string[] {
  return Array.from(resolverRegistry.keys());
}

// Register built-in resolvers
registerResolver(pendingInteractionResolver);
registerResolver(pendingQuestionResolver);
registerResolver(accessRequestResolver);
registerResolver(toolGrantRequestResolver);
