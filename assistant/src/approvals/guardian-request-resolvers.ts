/**
 * Resolver registry for canonical guardian requests.
 *
 * Dispatches to kind-specific resolvers after the unified decision primitive
 * has validated identity, status, and performed CAS resolution.  Each
 * resolver adapts the existing side-effect logic (channel approval handling,
 * voice call answer delivery) to the canonical request domain.
 *
 * The registry is intentionally a simple Map keyed by request kind.  New
 * request kinds (access_request, etc.) can register resolvers here without
 * touching the core decision primitive.
 */

import { answerCall } from "../calls/call-domain.js";
import { getGatewayInternalBaseUrl } from "../config/env.js";
import { upsertContactChannel } from "../contacts/contacts-write.js";
import {
  type CanonicalGuardianRequest,
  getCanonicalGuardianRequest,
} from "../memory/canonical-guardian-store.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import {
  isNotificationSourceChannel,
  type NotificationSourceChannel,
} from "../notifications/signal.js";
import { addRule } from "../permissions/trust-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { mintDaemonDeliveryToken } from "../runtime/auth/token-service.js";
import type { ApprovalAction } from "../runtime/channel-approval-types.js";
import { createOutboundSession } from "../runtime/channel-verification-service.js";
import { deliverChannelReply } from "../runtime/gateway-client.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { getTool } from "../tools/registry.js";
import { TC_GRANT_WAIT_MAX_MS } from "../tools/tool-approval-handler.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-request-resolvers");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  /** The effective action after any downgrade (e.g. approve_always -> approve_once). */
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

/** Context passed to each resolver after CAS resolution succeeds. */
export interface ResolverContext {
  /** The canonical request record (already resolved to its terminal status). */
  request: CanonicalGuardianRequest;
  /** The decision being applied. */
  decision: ResolverDecision;
  /** Actor context for the entity making the decision. */
  actor: ActorContext;
  /** Optional channel delivery context — present when the decision arrived via a channel message. */
  channelDeliveryContext?: ChannelDeliveryContext;
  /** Optional emission context threaded to handleConfirmationResponse for correct source attribution. */
  emissionContext?: ResolverEmissionContext;
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

function resolveDeliverCallbackUrlForChannel(channel: string): string | null {
  switch (channel) {
    case "telegram":
    case "whatsapp":
    case "slack":
      return `${getGatewayInternalBaseUrl()}/deliver/${channel}`;
    default:
      return null;
  }
}

/** Interface that kind-specific resolvers implement. */
export interface GuardianRequestResolver {
  /** The request kind this resolver handles (matches canonical_guardian_requests.kind). */
  kind: string;
  /** Execute kind-specific side effects after CAS resolution. */
  resolve(context: ResolverContext): Promise<ResolverResult>;
}

// ---------------------------------------------------------------------------
// Resolver implementations
// ---------------------------------------------------------------------------

/**
 * Resolves `tool_approval` requests — the channel/desktop approval path.
 *
 * Adapts the existing `handleChannelDecision` logic: looks up the pending
 * interaction by conversation ID, maps the canonical decision to the
 * session's confirmation response, and resolves the interaction.
 *
 * Side effects are deferred to callers that wire into existing channel
 * approval infrastructure.  This resolver focuses on validating that the
 * request shape is appropriate for tool_approval handling.
 */
const pendingInteractionResolver: GuardianRequestResolver = {
  kind: "tool_approval",

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision } = ctx;

    if (!request.conversationId) {
      return {
        ok: false,
        reason: "tool_approval request missing conversationId",
      };
    }

    // Look up the pending interaction directly by requestId.
    const interaction = pendingInteractions.get(request.id);
    if (!interaction) {
      // The pending interaction was already consumed (stale) or not found.
      // The canonical CAS already committed, so this is not an error — just
      // means the interaction was resolved by another path (e.g. timeout).
      log.warn(
        {
          event: "resolver_tool_approval_stale",
          requestId: request.id,
          conversationId: request.conversationId,
        },
        "Tool approval resolver: pending interaction not found (already consumed or timed out)",
      );
      return { ok: false, reason: "pending_interaction_not_found" };
    }

    // Handle approve_always: persist a trust rule when the confirmation
    // explicitly allows persistence and provides explicit options.
    if (
      decision.action === "approve_always" ||
      decision.action === "approve_once"
    ) {
      const details = interaction.confirmationDetails;
      if (
        decision.action === "approve_always" &&
        details &&
        details.persistentDecisionsAllowed !== false &&
        details.allowlistOptions?.length
      ) {
        const pattern = details.allowlistOptions[0].pattern;
        // Non-scoped tools (web_fetch, network_request, etc.) have empty
        // scopeOptions — default to 'everywhere' so approve_always still
        // persists a trust rule instead of silently degrading to one-time.
        const scope = details.scopeOptions?.length
          ? details.scopeOptions[0].scope
          : "everywhere";
        const tool = getTool(details.toolName);
        const executionTarget =
          tool?.origin === "skill" ? details.executionTarget : undefined;
        addRule(details.toolName, pattern, scope, "allow", 100, {
          executionTarget,
        });
      }
    }

    // Resolve the interaction: remove from tracker and get the session.
    const resolved = pendingInteractions.resolve(request.id);
    if (!resolved) {
      // Race condition: interaction was consumed between get() and resolve().
      log.warn(
        {
          event: "resolver_tool_approval_resolve_race",
          requestId: request.id,
        },
        "Tool approval resolver: pending interaction consumed between lookup and resolve",
      );
      return { ok: false, reason: "pending_interaction_race" };
    }

    // Map action to the permission system's UserDecision type and notify session.
    const userDecision =
      decision.action === "reject" ? ("deny" as const) : ("allow" as const);
    resolved.conversation.handleConfirmationResponse(
      request.id,
      userDecision,
      undefined,
      undefined,
      undefined,
      ctx.emissionContext,
    );

    log.info(
      {
        event: "resolver_tool_approval_applied",
        requestId: request.id,
        action: decision.action,
        conversationId: request.conversationId,
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
 * Adapts the existing `answerCall` + `resolveGuardianActionRequest` logic:
 * validates that voice-specific fields (callSessionId, pendingQuestionId)
 * are present, and signals that the answer has been captured.
 *
 * Actual call session answer delivery is handled downstream by existing
 * voice infrastructure.  This resolver validates the request shape and
 * records the resolution.
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
      // The canonical CAS has already committed so we don't roll back the
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
      "Pending question resolver: canonical decision applied",
    );

    return { ok: true, applied: true };
  },
};

/**
 * Resolves `access_request` requests — channel access request approvals.
 *
 * Access requests don't have pending interactions in the session tracker.
 * Instead, they create identity-bound verification sessions so the requester
 * can prove their identity.
 *
 * This resolver directly mints the verification session on approve rather
 * than going through handleAccessRequestDecision -> resolveApprovalRequest,
 * because canonical requests have no legacy channel_guardian_approval_requests
 * row, making the resolveApprovalRequest step a no-op that returns 'stale'.
 *
 * When a `channelDeliveryContext` is provided (channel path), the resolver
 * also delivers the verification code to the guardian, notifies the requester,
 * and emits lifecycle notification signals — mirroring the legacy
 * handleAccessRequestApproval side effects.
 *
 * For deny: notifies the requester and emits denial lifecycle signals when
 * channelDeliveryContext is available.
 */
const accessRequestResolver: GuardianRequestResolver = {
  kind: "access_request",

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision, channelDeliveryContext } = ctx;
    const channel: NotificationSourceChannel = isNotificationSourceChannel(
      request.sourceChannel,
    )
      ? request.sourceChannel
      : "vellum";
    const requesterExternalUserId = request.requesterExternalUserId ?? "";
    const requesterChatId =
      request.requesterChatId ?? request.requesterExternalUserId ?? "";
    const requesterLabel =
      requesterExternalUserId || requesterChatId || "the requester";
    const decidedByExternalUserId = ctx.actor.actorExternalUserId ?? "";
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
    const desktopDeliverUrl = resolveDeliverCallbackUrlForChannel(channel);
    const desktopBearerToken = mintDaemonDeliveryToken();

    if (decision.action === "reject") {
      log.info(
        { event: "resolver_access_request_denied", requestId: request.id },
        "Access request resolver: deny",
      );

      // Deliver denial notification and lifecycle signals when channel context is available
      if (channelDeliveryContext) {
        try {
          await deliverChannelReply(
            channelDeliveryContext.replyCallbackUrl,
            {
              chatId: requesterChatId,
              text: "Your access request has been denied by the guardian.",
              assistantId,
            },
            channelDeliveryContext.bearerToken,
          );
        } catch (err) {
          log.error(
            { err, requesterChatId },
            "Failed to notify requester of access request denial",
          );
        }

        const deniedPayload = {
          sourceChannel: channel,
          requesterExternalUserId,
          requesterChatId,
          decidedByExternalUserId,
          decision: "denied" as const,
        };

        void emitNotificationSignal({
          sourceEventName: "ingress.trusted_contact.guardian_decision",
          sourceChannel: channel,
          sourceContextId: request.conversationId ?? "",
          attentionHints: {
            requiresAction: false,
            urgency: "medium",
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
          contextPayload: deniedPayload,
          dedupeKey: `trusted-contact:guardian-decision:${request.id}`,
        });

        void emitNotificationSignal({
          sourceEventName: "ingress.trusted_contact.denied",
          sourceChannel: channel,
          sourceContextId: request.conversationId ?? "",
          attentionHints: {
            requiresAction: false,
            urgency: "low",
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
          contextPayload: deniedPayload,
          dedupeKey: `trusted-contact:denied:${request.id}`,
        });
      } else if (desktopDeliverUrl && requesterChatId) {
        // For Slack, route to DM via requesterExternalUserId (user ID) instead
        // of requesterChatId (channel ID) to avoid posting in public channels.
        const targetChatId =
          channel === "slack" && requesterExternalUserId
            ? requesterExternalUserId
            : requesterChatId;
        try {
          await deliverChannelReply(
            desktopDeliverUrl,
            {
              chatId: targetChatId,
              text: "Your access request has been denied by the guardian.",
              assistantId,
            },
            desktopBearerToken,
          );
        } catch (err) {
          log.error(
            { err, requesterChatId },
            "Failed to notify requester of access request denial (desktop decision path)",
          );
        }
      }

      return {
        ok: true,
        applied: true,
        // Desktop actors (vellum channel) receive inline reply text; channel
        // actors get replies delivered via the channel delivery context.
        ...(ctx.actor.channel === "vellum"
          ? { guardianReplyText: `Access denied for ${requesterLabel}.` }
          : {}),
      };
    }

    // Voice approvals: directly activate the trusted contact without minting
    // a verification session. The caller is already on the line and the
    // relay server's in-call wait loop will detect the approved status.
    if (channel === "phone") {
      try {
        upsertContactChannel({
          sourceChannel: "phone",
          externalUserId: requesterExternalUserId,
          externalChatId: requesterChatId,
          status: "active",
          policy: "allow",
        });
      } catch (err) {
        log.error(
          { err, requesterExternalUserId },
          "Access request resolver: failed to activate voice caller as trusted contact",
        );
      }

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

    // Non-voice approvals: mint an identity-bound verification session so the
    // requester can verify their identity.
    const session = createOutboundSession({
      channel,
      expectedExternalUserId: requesterExternalUserId,
      expectedChatId: requesterChatId,
      identityBindingStatus: "bound",
      destinationAddress: requesterChatId,
      verificationPurpose: "trusted_contact",
    });

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
        `You approved access for ${requesterExternalUserId}. ` +
        `Give them this verification code: \`${session.secret}\`. ` +
        `The code expires in 10 minutes.`;
      try {
        await deliverChannelReply(
          channelDeliveryContext.replyCallbackUrl,
          {
            chatId: channelDeliveryContext.guardianChatId,
            text: codeText,
            assistantId,
          },
          channelDeliveryContext.bearerToken,
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
        // Strip threadTs from the callback URL — it belongs to the shared
        // channel thread and would cause thread_not_found errors in the DM.
        let dmCallbackUrl = channelDeliveryContext.replyCallbackUrl;
        try {
          const url = new URL(channelDeliveryContext.replyCallbackUrl);
          url.searchParams.delete("threadTs");
          dmCallbackUrl = url.toString();
        } catch {
          // Malformed URL — use as-is
        }

        try {
          await deliverChannelReply(
            dmCallbackUrl,
            {
              chatId: guardianUserId,
              text: codeText,
              assistantId,
            },
            channelDeliveryContext.bearerToken,
          );
        } catch (err) {
          // Best-effort: the code was already delivered in the shared channel
          log.warn(
            { err, guardianUserId },
            "Failed to send guardian DM confirmation with verification code",
          );
        }
      }

      // Notify the requester. For Slack, route to DM via the user ID and
      // strip threadTs (which belongs to the guardian's channel thread).
      const requesterTargetChatId =
        channel === "slack" && requesterExternalUserId
          ? requesterExternalUserId
          : requesterChatId;
      let requesterCallbackUrl = channelDeliveryContext.replyCallbackUrl;
      if (channel === "slack" && requesterExternalUserId) {
        try {
          const url = new URL(channelDeliveryContext.replyCallbackUrl);
          url.searchParams.delete("threadTs");
          requesterCallbackUrl = url.toString();
        } catch {
          // Malformed URL — use as-is
        }
      }

      if (codeDelivered) {
        try {
          await deliverChannelReply(
            requesterCallbackUrl,
            {
              chatId: requesterTargetChatId,
              text:
                "Your access request has been approved! " +
                "Please enter the 6-digit verification code you receive from the guardian.",
              assistantId,
            },
            channelDeliveryContext.bearerToken,
          );
          requesterNotified = true;
        } catch (err) {
          log.error(
            { err, requesterChatId },
            "Failed to notify requester of access request approval",
          );
        }
      } else {
        try {
          await deliverChannelReply(
            requesterCallbackUrl,
            {
              chatId: requesterTargetChatId,
              text:
                "Your access request was approved, but we were unable to " +
                "deliver the verification code. Please try again later.",
              assistantId,
            },
            channelDeliveryContext.bearerToken,
          );
        } catch (err) {
          log.error(
            { err, requesterChatId },
            "Failed to notify requester of delivery failure",
          );
        }
      }

      // Emit verification_sent with visibleInSourceNow=true so the notification
      // pipeline suppresses delivery — the guardian already received the code.
      if (codeDelivered) {
        void emitNotificationSignal({
          sourceEventName: "ingress.trusted_contact.verification_sent",
          sourceChannel: channel,
          sourceContextId: request.conversationId ?? "",
          attentionHints: {
            requiresAction: false,
            urgency: "low",
            isAsyncBackground: true,
            visibleInSourceNow: true,
          },
          contextPayload: {
            sourceChannel: channel,
            requesterExternalUserId,
            requesterChatId,
            verificationSessionId: session.sessionId,
          },
          dedupeKey: `trusted-contact:verification-sent:${session.sessionId}`,
        });
      }
    } else if (desktopDeliverUrl && requesterChatId) {
      // For Slack, route to DM via requesterExternalUserId (user ID) instead
      // of requesterChatId (channel ID) to avoid posting in public channels.
      const targetChatId =
        channel === "slack" && requesterExternalUserId
          ? requesterExternalUserId
          : requesterChatId;
      try {
        await deliverChannelReply(
          desktopDeliverUrl,
          {
            chatId: targetChatId,
            text:
              "Your access request has been approved! " +
              "Please enter the 6-digit verification code you receive from the guardian.",
            assistantId,
          },
          desktopBearerToken,
        );
        requesterNotified = true;
      } catch (err) {
        log.error(
          { err, requesterChatId },
          "Failed to notify requester of access request approval (desktop decision path)",
        );
      }
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
 * requester's tool call was already denied, and the canonical request exists
 * solely so the guardian can mint a scoped grant.
 *
 * On approve: the canonical decision primitive mints the grant (step 6 in
 * applyCanonicalGuardianDecision). This resolver optionally notifies the
 * requester to retry.
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
          await deliverChannelReply(
            channelDeliveryContext.replyCallbackUrl,
            {
              chatId: requesterChatId,
              text: `Your request to use "${request.toolName}" has been denied by the guardian.`,
              assistantId,
            },
            channelDeliveryContext.bearerToken,
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

    // On approve: grant minting is handled by the canonical decision primitive
    // (step 6). This resolver only handles requester notification.
    log.info(
      {
        event: "resolver_tool_grant_request_approved",
        requestId: request.id,
        toolName: request.toolName,
      },
      "Tool grant request resolver: approved (grant minting deferred to canonical primitive)",
    );

    // Re-read the canonical request to check whether an inline grant waiter
    // has already claimed this request. When followupState is
    // 'inline_wait_active', the requester's original tool call is blocking
    // on the grant and will resume automatically — sending a "please retry"
    // notification would be stale and confusing (and could cause duplicate
    // attempts or one-time-grant denials).
    //
    // Staleness guard: the inline_wait_active marker is persisted in DB and
    // can outlive the actual waiter if the daemon crashes or restarts during
    // the wait. To avoid permanently suppressing the retry notification, we
    // treat the marker as stale if the encoded start timestamp is older than
    // the maximum wait budget plus a 30s buffer.
    const INLINE_WAIT_STALENESS_BUFFER_MS = 30_000;
    const freshRequest = getCanonicalGuardianRequest(request.id);
    const followupState = freshRequest?.followupState ?? "";
    let inlineWaitActive = followupState.startsWith("inline_wait_active");
    if (inlineWaitActive && freshRequest) {
      // The followupState encodes the wall-clock epoch when the inline wait
      // started (e.g. 'inline_wait_active:1700000000000'). We use this
      // instead of updatedAt because resolveCanonicalGuardianRequest sets
      // updatedAt = now during CAS resolution, making updatedAt always fresh
      // by the time this resolver runs.
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
        await deliverChannelReply(
          channelDeliveryContext.replyCallbackUrl,
          {
            chatId: requesterChatId,
            text: `Your request to use "${request.toolName}" has been approved. Please retry your request.`,
            assistantId,
          },
          channelDeliveryContext.bearerToken,
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
export function registerResolver(resolver: GuardianRequestResolver): void {
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
