/**
 * Pure routing logic extracted from RelayConnection.handleSetup.
 *
 * Given a setup context (call session, actor trust, voice config, ACL policy),
 * returns a discriminated union describing what the relay connection should do
 * next — without performing any side effects itself.
 */

import { getConfig } from "../config/loader.js";
import { findActiveVoiceInvites } from "../memory/invite-store.js";
import {
  type ActorTrustContext,
  resolveActorTrust,
} from "../runtime/actor-trust-resolver.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { getPendingSession } from "../runtime/channel-verification-service.js";
import { getLogger } from "../util/logger.js";
import type { CallSession } from "./types.js";

const log = getLogger("relay-setup-router");

// ── Setup context ────────────────────────────────────────────────────

export interface SetupContext {
  callSessionId: string;
  session: CallSession | null;
  from: string;
  to: string;
  customParameters?: Record<string, string>;
}

// ── Setup outcomes ───────────────────────────────────────────────────

export type SetupOutcome =
  | { action: "normal_call"; isInbound: boolean }
  | {
      action: "verification";
      assistantId: string;
      fromNumber: string;
    }
  | {
      action: "outbound_verification";
      assistantId: string;
      sessionId: string;
      toNumber: string;
    }
  | {
      action: "callee_verification";
      verificationConfig: { maxAttempts: number; codeLength: number };
    }
  | {
      action: "invite_redemption";
      assistantId: string;
      fromNumber: string;
      friendName: string | null;
      guardianName: string | null;
    }
  | { action: "name_capture"; assistantId: string; fromNumber: string }
  | { action: "deny"; message: string; logReason: string };

// ── Resolved context produced alongside the outcome ──────────────────

export interface SetupResolved {
  assistantId: string;
  isInbound: boolean;
  otherPartyNumber: string;
  actorTrust: ActorTrustContext;
}

// ── Router ───────────────────────────────────────────────────────────

/**
 * Determine the setup outcome for an incoming relay connection.
 *
 * This function is pure routing logic — it reads state but performs no
 * side effects (no call-session mutations, no event recording, no WS
 * messages). The caller (`RelayConnection.handleSetup`) is responsible
 * for acting on the returned outcome.
 */
export function routeSetup(ctx: SetupContext): {
  outcome: SetupOutcome;
  resolved: SetupResolved;
} {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const isInbound = ctx.session?.initiatedFromConversationId == null;
  const otherPartyNumber = isInbound ? ctx.from : ctx.to;

  const actorTrust = resolveActorTrust({
    assistantId,
    sourceChannel: "phone",
    conversationExternalId: otherPartyNumber,
    actorExternalId: otherPartyNumber || undefined,
  });

  const resolved: SetupResolved = {
    assistantId,
    isInbound,
    otherPartyNumber,
    actorTrust,
  };

  // ── Outbound guardian verification (persisted mode) ──────────────
  const persistedMode = ctx.session?.callMode;
  const persistedVsId = ctx.session?.verificationSessionId;
  const customParamVsId = ctx.customParameters?.verificationSessionId;
  const verificationSessionId = persistedVsId ?? customParamVsId;

  if (persistedMode === "verification" && verificationSessionId) {
    return {
      outcome: {
        action: "outbound_verification",
        assistantId,
        sessionId: verificationSessionId,
        toNumber: ctx.to,
      },
      resolved,
    };
  }

  // Secondary signal: custom parameter without persisted mode (pre-migration)
  if (!persistedMode && customParamVsId) {
    log.warn(
      {
        callSessionId: ctx.callSessionId,
        verificationSessionId: customParamVsId,
      },
      "Guardian verification detected via setup custom parameter (no persisted call_mode) — entering verification path",
    );
    return {
      outcome: {
        action: "outbound_verification",
        assistantId,
        sessionId: customParamVsId,
        toNumber: ctx.to,
      },
      resolved,
    };
  }

  // ── Outbound callee verification ────────────────────────────────
  const config = getConfig();
  const verificationConfig = config.calls.verification;
  if (!isInbound && verificationConfig.enabled) {
    return {
      outcome: {
        action: "callee_verification",
        verificationConfig,
      },
      resolved,
    };
  }

  // ── Outbound normal call ────────────────────────────────────────
  if (!isInbound) {
    return {
      outcome: { action: "normal_call", isInbound: false },
      resolved,
    };
  }

  // ── Inbound call ACL evaluation ─────────────────────────────────
  const pendingChallenge = getPendingSession("phone");

  if (actorTrust.trustClass === "unknown" && !pendingChallenge) {
    // Check for blocked caller
    if (actorTrust.memberRecord?.channel.status === "blocked") {
      log.info(
        {
          callSessionId: ctx.callSessionId,
          from: ctx.from,
          trustClass: actorTrust.trustClass,
        },
        "Inbound voice ACL: blocked caller denied",
      );
      return {
        outcome: {
          action: "deny",
          message: "This number is not authorized to use this assistant.",
          logReason: "Inbound voice ACL: caller blocked",
        },
        resolved,
      };
    }

    // Check for active voice invites
    let voiceInvites: ReturnType<typeof findActiveVoiceInvites> = [];
    try {
      voiceInvites = findActiveVoiceInvites({
        expectedExternalUserId: ctx.from,
      });
    } catch (err) {
      log.warn(
        { err, callSessionId: ctx.callSessionId },
        "Failed to check voice invites for unknown caller",
      );
    }

    const now = Date.now();
    const nonExpiredInvites = voiceInvites.filter(
      (i) => !i.expiresAt || i.expiresAt > now,
    );

    if (nonExpiredInvites.length > 0) {
      const matchedInvite = nonExpiredInvites[0];
      log.info(
        { callSessionId: ctx.callSessionId, from: ctx.from },
        "Inbound voice ACL: unknown caller has active voice invite — entering redemption flow",
      );
      return {
        outcome: {
          action: "invite_redemption",
          assistantId,
          fromNumber: ctx.from,
          friendName: matchedInvite.friendName,
          guardianName: matchedInvite.guardianName,
        },
        resolved,
      };
    }

    // Unknown caller — name capture flow
    log.info(
      {
        callSessionId: ctx.callSessionId,
        from: ctx.from,
        trustClass: actorTrust.trustClass,
      },
      "Inbound voice ACL: unknown caller — entering name capture flow",
    );
    return {
      outcome: {
        action: "name_capture",
        assistantId,
        fromNumber: ctx.from,
      },
      resolved,
    };
  }

  // Members with policy: 'deny'
  if (actorTrust.memberRecord?.channel.policy === "deny") {
    log.info(
      {
        callSessionId: ctx.callSessionId,
        from: ctx.from,
        channelId: actorTrust.memberRecord.channel.id,
        trustClass: actorTrust.trustClass,
      },
      "Inbound voice ACL: member policy deny",
    );
    return {
      outcome: {
        action: "deny",
        message: "This number is not authorized to use this assistant.",
        logReason: "Inbound voice ACL: member policy deny",
      },
      resolved,
    };
  }

  // Members with policy: 'escalate' — live calls can't wait for approval
  if (actorTrust.memberRecord?.channel.policy === "escalate") {
    log.info(
      {
        callSessionId: ctx.callSessionId,
        from: ctx.from,
        channelId: actorTrust.memberRecord.channel.id,
        trustClass: actorTrust.trustClass,
      },
      "Inbound voice ACL: member policy escalate — cannot hold live call for guardian approval",
    );
    return {
      outcome: {
        action: "deny",
        message:
          "This number requires guardian approval for calls. Please have the account guardian update your permissions.",
        logReason:
          "Inbound voice ACL: member policy escalate — voice calls cannot await guardian approval",
      },
      resolved,
    };
  }

  // Guardian verification challenge
  if (pendingChallenge) {
    return {
      outcome: {
        action: "verification",
        assistantId,
        fromNumber: ctx.from,
      },
      resolved,
    };
  }

  // Guardian and trusted-contact callers proceed normally
  return {
    outcome: { action: "normal_call", isInbound: true },
    resolved,
  };
}
