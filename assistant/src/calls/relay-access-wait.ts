/**
 * Extracted helper functions for the guardian access-request wait flow.
 *
 * These were previously private methods on RelayConnection. Pulling them
 * into a standalone module keeps the class focused on WebSocket lifecycle
 * and makes the wait-state logic independently testable.
 */

import { findContactChannel } from "../contacts/contact-store.js";
import { getCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import { getLogger } from "../util/logger.js";
import {
  getGuardianWaitUpdateInitialIntervalMs,
  getGuardianWaitUpdateInitialWindowMs,
  getGuardianWaitUpdateSteadyMaxIntervalMs,
  getGuardianWaitUpdateSteadyMinIntervalMs,
} from "./call-constants.js";
import { recordCallEvent } from "./call-store.js";

const log = getLogger("relay-access-wait");

// ── Wait-utterance classification ────────────────────────────────────

export type WaitUtteranceClass =
  | "empty"
  | "patience_check"
  | "impatient"
  | "callback_opt_in"
  | "callback_decline"
  | "neutral";

/**
 * Classify a caller utterance during guardian wait into one of:
 * - 'empty': whitespace or noise
 * - 'patience_check': asking for status or checking in
 * - 'impatient': expressing frustration or wanting to end
 * - 'callback_opt_in': explicitly agreeing to a callback
 * - 'callback_decline': explicitly declining a callback
 * - 'neutral': anything else
 */
export function classifyWaitUtterance(
  text: string,
  callbackOfferMade: boolean,
): WaitUtteranceClass {
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return "empty";

  // Callback opt-in patterns (check before impatience to catch "yes call me back")
  if (callbackOfferMade) {
    if (
      /\b(yes|yeah|yep|sure|okay|ok|please)\b.*\b(call\s*(me\s*)?back|callback)\b/.test(
        lower,
      ) ||
      /\b(call\s*(me\s*)?back|callback)\b.*\b(yes|yeah|please|sure)\b/.test(
        lower,
      ) ||
      /^(yes|yeah|yep|sure|okay|ok|please)\s*[.,!]?\s*$/.test(lower) ||
      /\bcall\s*(me\s*)?back\b/.test(lower) ||
      /\bplease\s+do\b/.test(lower)
    ) {
      return "callback_opt_in";
    }
    if (
      /\b(no|nah|nope)\b/.test(lower) ||
      /\bi('?ll| will)\s+hold\b/.test(lower) ||
      /\bi('?ll| will)\s+wait\b/.test(lower)
    ) {
      return "callback_decline";
    }
  }

  // Impatience patterns
  if (
    /\bhurry\s*(up)?\b/.test(lower) ||
    /\btaking\s+(too\s+|so\s+)?long\b/.test(lower) ||
    /\bforget\s+it\b/.test(lower) ||
    /\bnever\s*mind\b/.test(lower) ||
    /\bdon'?t\s+have\s+time\b/.test(lower) ||
    /\bhow\s+much\s+longer\b/.test(lower) ||
    /\bi('?m| am)\s+(getting\s+)?impatient\b/.test(lower) ||
    /\bthis\s+is\s+(ridiculous|absurd|crazy)\b/.test(lower) ||
    /\bcome\s+on\b/.test(lower) ||
    /\bi\s+(gotta|have\s+to|need\s+to)\s+go\b/.test(lower)
  ) {
    return "impatient";
  }

  // Patience check / status inquiry patterns
  if (
    /\bhello\??\s*$/.test(lower) ||
    /\bstill\s+there\b/.test(lower) ||
    /\bany\s+(update|news)\b/.test(lower) ||
    /\bwhat('?s| is)\s+(happening|going\s+on)\b/.test(lower) ||
    /\bare\s+you\s+still\b/.test(lower) ||
    /\bhow\s+(long|much\s+longer)\b/.test(lower) ||
    /\banyone\s+there\b/.test(lower)
  ) {
    return "patience_check";
  }

  return "neutral";
}

// ── Heartbeat messages ───────────────────────────────────────────────

/**
 * Generate a non-repetitive heartbeat message for the caller based
 * on the current sequence counter and guardian label.
 */
export function getHeartbeatMessage(
  sequence: number,
  guardianLabel: string,
): string {
  const messages = [
    `Still waiting to hear back from ${guardianLabel}. Thank you for your patience.`,
    `I'm still trying to reach ${guardianLabel}. One moment please.`,
    `Hang tight, still waiting on ${guardianLabel}.`,
    `Still checking with ${guardianLabel}. I appreciate you waiting.`,
    `I haven't heard back from ${guardianLabel} yet. Thanks for holding.`,
  ];
  return messages[sequence % messages.length];
}

// ── Heartbeat scheduling ─────────────────────────────────────────────

export interface ScheduleNextHeartbeatParams {
  isWaitActive: () => boolean;
  accessRequestWaitStartedAt: number;
  callSessionId: string;
  /** Called to get the current sequence number and advance it. */
  consumeSequence: () => number;
  resolveGuardianLabel: () => string;
  sendTextToken: (text: string, last: boolean) => void;
  /** Called after each heartbeat to schedule the next one. */
  scheduleNext: () => void;
}

/**
 * Schedule the next heartbeat update. Uses the initial fixed interval
 * during the initial window, then jitters between steady min/max.
 *
 * Returns the timer handle so the caller can clear it.
 */
export function scheduleNextHeartbeat(
  params: ScheduleNextHeartbeatParams,
): ReturnType<typeof setTimeout> | null {
  if (!params.isWaitActive()) return null;

  const elapsed = Date.now() - params.accessRequestWaitStartedAt;
  const initialWindow = getGuardianWaitUpdateInitialWindowMs();
  const intervalMs =
    elapsed < initialWindow
      ? getGuardianWaitUpdateInitialIntervalMs()
      : getGuardianWaitUpdateSteadyMinIntervalMs() +
        Math.floor(
          Math.random() *
            Math.max(
              0,
              getGuardianWaitUpdateSteadyMaxIntervalMs() -
                getGuardianWaitUpdateSteadyMinIntervalMs(),
            ),
        );

  return setTimeout(() => {
    if (!params.isWaitActive()) return;

    const seq = params.consumeSequence();
    const guardianLabel = params.resolveGuardianLabel();
    const message = getHeartbeatMessage(seq, guardianLabel);
    params.sendTextToken(message, true);

    recordCallEvent(
      params.callSessionId,
      "voice_guardian_wait_heartbeat_sent",
      {
        sequence: seq,
        message,
      },
    );

    log.debug(
      {
        callSessionId: params.callSessionId,
        sequence: seq,
      },
      "Guardian wait heartbeat sent",
    );

    // Schedule the next heartbeat
    params.scheduleNext();
  }, intervalMs);
}

// ── Callback handoff notification ────────────────────────────────────

export interface EmitAccessRequestCallbackHandoffParams {
  reason: "timeout" | "transport_closed";
  callbackOptIn: boolean;
  accessRequestId: string | null;
  callbackHandoffNotified: boolean;
  accessRequestAssistantId: string | null;
  accessRequestFromNumber: string | null;
  accessRequestCallerName: string | null;
  callSessionId: string;
}

export interface EmitAccessRequestCallbackHandoffResult {
  /** Whether the notification was actually emitted. */
  emitted: boolean;
  /** Updated callbackHandoffNotified flag for the caller to persist. */
  callbackHandoffNotified: boolean;
}

/**
 * Emit a callback handoff notification to the guardian when the caller
 * opted into a callback during guardian wait but the wait ended without
 * resolution (timeout or transport close).
 *
 * Idempotent: uses callbackHandoffNotified guard + deterministic dedupeKey
 * to ensure at most one notification per call/request.
 */
export function emitAccessRequestCallbackHandoff(
  params: EmitAccessRequestCallbackHandoffParams,
): EmitAccessRequestCallbackHandoffResult {
  if (!params.callbackOptIn) {
    return {
      emitted: false,
      callbackHandoffNotified: params.callbackHandoffNotified,
    };
  }
  if (!params.accessRequestId) {
    return {
      emitted: false,
      callbackHandoffNotified: params.callbackHandoffNotified,
    };
  }
  if (params.callbackHandoffNotified) {
    return { emitted: false, callbackHandoffNotified: true };
  }

  const fromNumber = params.accessRequestFromNumber ?? null;

  // Resolve canonical request for requestCode and conversationId
  const canonicalRequest = params.accessRequestId
    ? getCanonicalGuardianRequest(params.accessRequestId)
    : null;

  // Resolve trusted-contact member reference when possible
  let requesterMemberId: string | null = null;
  if (fromNumber) {
    try {
      const contactResult = findContactChannel({
        channelType: "phone",
        externalUserId: fromNumber,
        externalChatId: fromNumber,
      });
      if (
        contactResult &&
        contactResult.channel.status === "active" &&
        contactResult.channel.policy === "allow"
      ) {
        requesterMemberId = contactResult.channel.id;
      }
    } catch (err) {
      log.warn(
        { err, callSessionId: params.callSessionId },
        "Failed to resolve member for callback handoff",
      );
    }
  }

  const dedupeKey = `access-request-callback-handoff:${params.accessRequestId}`;
  const sourceContextId =
    canonicalRequest?.conversationId ??
    `access-req-callback-${params.accessRequestId}`;

  void emitNotificationSignal({
    sourceEventName: "ingress.access_request.callback_handoff",
    sourceChannel: "phone",
    sourceContextId,
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId: params.accessRequestId,
      requestCode: canonicalRequest?.requestCode ?? null,
      callSessionId: params.callSessionId,
      sourceChannel: "phone",
      reason: params.reason,
      callbackOptIn: true,
      callerPhoneNumber: fromNumber,
      callerName: params.accessRequestCallerName ?? null,
      requesterExternalUserId: fromNumber,
      requesterChatId: fromNumber,
      requesterMemberId,
      requesterMemberSourceChannel: requesterMemberId ? "phone" : null,
    },
    dedupeKey,
  })
    .then(() => {
      recordCallEvent(params.callSessionId, "callback_handoff_notified", {
        requestId: params.accessRequestId,
        reason: params.reason,
        requesterMemberId,
      });
      log.info(
        {
          callSessionId: params.callSessionId,
          requestId: params.accessRequestId,
          reason: params.reason,
        },
        "Callback handoff notification emitted",
      );
    })
    .catch((err) => {
      recordCallEvent(params.callSessionId, "callback_handoff_failed", {
        requestId: params.accessRequestId,
        reason: params.reason,
        error: err instanceof Error ? err.message : String(err),
      });
      log.error(
        {
          err,
          callSessionId: params.callSessionId,
          requestId: params.accessRequestId,
        },
        "Failed to emit callback handoff notification",
      );
    });

  return { emitted: true, callbackHandoffNotified: true };
}
