/**
 * Pure routing logic for the voice call setup phase.
 *
 * Given a setup context (call session, gateway trust verdict, voice config,
 * ACL policy), returns a discriminated union describing what the call session
 * should do next — without performing any side effects itself.
 *
 * The gateway verdict is the sole caller-trust source. An unusable verdict
 * (missing, `resolutionFailed`, or member-unresolvable) fails closed —
 * matching the text path's posture: inbound calls are denied, outbound setup
 * aborts.
 */

import type { AdmissionPolicy, TrustVerdict } from "@vellumai/gateway-client";

import { getPendingSession } from "../channels/gateway-verification-sessions.js";
import { getConfig } from "../config/loader.js";
import type { ActorTrustContext } from "../runtime/actor-trust-resolver.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import {
  type AdmissionPolicyResult,
  enforceAdmissionPolicy,
} from "../runtime/routes/inbound-stages/admission-policy.js";
import {
  actorTrustContextFromVerdict,
  verdictUsability,
} from "../runtime/trust-verdict-consumer.js";
import { getLogger } from "../util/logger.js";
import { getActiveVoiceInvite } from "./gateway-invite-reader.js";
import type { CallSession } from "./types.js";

const log = getLogger("call-setup-router");

// ── Setup context ────────────────────────────────────────────────────

interface SetupContext {
  callSessionId: string;
  session: CallSession | null;
  from: string;
  to: string;
  customParameters?: Record<string, string>;
  /**
   * Per-channel inbound admission floor for the `phone` channel, supplied by
   * the caller. When absent/`null`, the floor check is skipped entirely —
   * preserving all pre-admission behavior.
   */
  admissionPolicy?: AdmissionPolicy | null;
  /**
   * Gateway-stamped caller trust verdict — the sole caller-trust source.
   * A missing/failed/member-unresolvable verdict fails closed (inbound deny,
   * outbound setup abort).
   */
  verdict?: TrustVerdict | null;
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
      /**
       * Display name of the invitee. For inbound redemptions, supplied by the
       * gateway's active-voice-invite read (bound contact `displayName`
       * preferred, invite `friendName` fallback). For outbound invite calls,
       * carries the session-recorded `inviteFriendName`. When null/empty, the
       * relay uses a neutral "Hi there" greeting instead of substituting the
       * channel address.
       */
      inviteeName: string | null;
    }
  | { action: "name_capture"; assistantId: string; fromNumber: string }
  | {
      action: "unverified_caller";
      assistantId: string;
      fromNumber: string;
      displayName: string;
      isGuardian: boolean;
    }
  | { action: "deny"; message: string; logReason: string };

// ── Resolved context produced alongside the outcome ──────────────────

export interface SetupResolved {
  assistantId: string;
  isInbound: boolean;
  otherPartyNumber: string;
  actorTrust: ActorTrustContext;
}

/**
 * Minimal unknown-trust context for the fail-closed deny, where no verdict
 * is available to build real trust from.
 */
function unresolvedActorTrust(otherPartyNumber: string): ActorTrustContext {
  return {
    canonicalSenderId: otherPartyNumber || null,
    guardianBindingMatch: null,
    memberRecord: null,
    trustClass: "unknown",
    actorMetadata: {
      identifier: otherPartyNumber || undefined,
      displayName: undefined,
      senderDisplayName: undefined,
      memberDisplayName: undefined,
      username: undefined,
      channel: "phone",
      trustStatus: "unknown",
    },
  };
}

// ── Router ───────────────────────────────────────────────────────────

/**
 * Determine the setup outcome for a starting call session.
 *
 * This function is pure routing logic — it reads state (including the
 * gateway's active-voice-invite view) but performs no side effects (no
 * call-session mutations, no event recording, no WS messages). The caller
 * (the media-stream server's start handler) is responsible for acting on
 * the returned outcome.
 */
export async function routeSetup(ctx: SetupContext): Promise<{
  outcome: SetupOutcome;
  resolved: SetupResolved;
}> {
  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const isInbound = ctx.session?.initiatedFromConversationId == null;
  const otherPartyNumber = isInbound ? ctx.from : ctx.to;

  // The gateway verdict is the sole caller-trust source; an unusable one
  // fails closed, mirroring the text path's resolutionFailed deny
  // (acl-enforcement.ts): inbound is denied with the unavailable copy and no
  // stranger-lane side effects; outbound (guardian-initiated) aborts setup
  // loudly via the transport's setup-failure teardown.
  const usability = verdictUsability(ctx.verdict);
  if (!usability.usable) {
    const { reason } = usability;
    if (!isInbound) {
      throw new Error(
        `Voice setup: caller trust verdict unavailable (${reason}) — aborting outbound setup`,
      );
    }
    log.warn(
      { callSessionId: ctx.callSessionId, from: ctx.from, reason },
      "Inbound voice ACL: trust verdict unavailable — denying fail-closed",
    );
    return {
      outcome: {
        action: "deny",
        message:
          "The assistant is unable to take this call right now. Please try again later.",
        logReason: `Inbound voice ACL: trust verdict unavailable (${reason}) — fail-closed deny`,
      },
      resolved: {
        assistantId,
        isInbound,
        otherPartyNumber,
        actorTrust: unresolvedActorTrust(otherPartyNumber),
      },
    };
  }

  const { verdict } = usability;
  const actorTrust = actorTrustContextFromVerdict(verdict, {
    sourceChannel: "phone",
    conversationExternalId: otherPartyNumber,
    actorDisplayName: undefined,
  });

  const resolved: SetupResolved = {
    assistantId,
    isInbound,
    otherPartyNumber,
    actorTrust,
  };

  // ── Outbound flow selection based on persisted call mode ──────────
  const persistedMode = ctx.session?.callMode;

  // ── Outbound invite redemption (persisted mode) ─────────────────
  if (persistedMode === "invite") {
    return {
      outcome: {
        action: "invite_redemption" as const,
        assistantId,
        fromNumber: ctx.to,
        inviteeName: ctx.session?.inviteFriendName ?? null,
      },
      resolved,
    };
  }

  // ── Outbound guardian verification (persisted mode) ──────────────
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
  // Gateway read; throws on transport failure (control-plane posture —
  // setup fails loudly rather than mis-routing past a pending challenge).
  // Skipped when the verdict stamps `hasInterceptableVerificationSession:
  // false` — the channel-scoped stamp is authoritative only as a negative
  // (same rule as the text path); `true`/absent falls back to the read.
  const pendingChallenge =
    verdict.hasInterceptableVerificationSession === false
      ? null
      : await getPendingSession("phone");

  // An admission floor is "active" only when a policy applies and no pending
  // verification challenge is in flight. While active, the floor IS the access
  // decision: an admitted caller bypasses the legacy identity flows
  // (unverified_caller / name_capture) and connects directly. When inactive
  // (null policy, flag off, exempt channel, reader failed open, or a pending
  // challenge), those legacy flows are preserved unchanged.
  const floorActive = ctx.admissionPolicy != null && !pendingChallenge;

  // Inbound admission floor verdict; defaults to admitted when inactive.
  const floorVerdict = floorActive
    ? enforceAdmissionPolicy({
        sourceChannel: "phone",
        trustClass: actorTrust.trustClass,
        memberStatus: actorTrust.memberRecord?.status,
        policy: ctx.admissionPolicy!,
      })
    : ({ admitted: true } as const);

  // Floor-deny outcome shared by the unknown-caller and member-caller branches.
  // Live calls cannot await async re-verification, so the floor's
  // `shouldChallenge` upgrade UX is not surfaced — same rationale as `escalate`.
  const floorDeny = (
    denyVerdict: Extract<AdmissionPolicyResult, { admitted: false }>,
  ) => {
    log.info(
      {
        callSessionId: ctx.callSessionId,
        from: ctx.from,
        trustClass: actorTrust.trustClass,
        effectivePolicy: denyVerdict.effectivePolicy,
      },
      "Inbound voice ACL: admission floor denied caller",
    );
    return {
      outcome: {
        action: "deny" as const,
        message:
          "This number is not authorized to reach the assistant right now.",
        logReason: `Inbound voice admission floor: ${denyVerdict.effectivePolicy}`,
      },
      resolved,
    };
  };

  if (
    (actorTrust.trustClass === "unknown" ||
      actorTrust.trustClass === "unverified_contact") &&
    !pendingChallenge
  ) {
    // Check for blocked caller
    if (actorTrust.memberRecord?.status === "blocked") {
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

    // Check for an active voice invite. The gateway row is the lifecycle
    // authority; the reader fails soft to `null` on any gateway failure, so a
    // gateway blip falls through to the unverified-caller flows below instead
    // of stalling setup.
    const voiceInvite = await getActiveVoiceInvite(ctx.from);

    if (voiceInvite) {
      log.info(
        { callSessionId: ctx.callSessionId, from: ctx.from },
        "Inbound voice ACL: unknown caller has active voice invite — entering redemption flow",
      );
      return {
        outcome: {
          action: "invite_redemption",
          assistantId,
          fromNumber: ctx.from,
          inviteeName: voiceInvite.inviteeName,
        },
        resolved,
      };
    }

    // When a floor is active it is the access decision: an admitted caller
    // connects directly (skipping unverified_caller / name_capture), and a
    // below-floor caller is denied. Invites (handled above) bypass the floor
    // as an explicit grant. When the floor is inactive (null policy), fall
    // through to the legacy identity flows below.
    if (floorActive) {
      if (!floorVerdict.admitted) {
        return floorDeny(floorVerdict);
      }
      return {
        outcome: { action: "normal_call" as const, isInbound: true },
        resolved,
      };
    }

    // Known caller whose channel hasn't passed verification yet —
    // mirrors the gateway's pre-intercept (twilio-voice-webhook.ts) so
    // calls slipping past it (e.g. canonicalization mismatch between
    // gateway and assistant DBs) still get useful guidance instead of
    // the "I don't recognize this number" name-capture script.
    const unverifiedStatuses = new Set(["unverified", "pending"]);
    const member = actorTrust.memberRecord;
    if (member && unverifiedStatuses.has(member.status)) {
      log.info(
        {
          callSessionId: ctx.callSessionId,
          from: ctx.from,
          channelId: member.channel.id,
          channelStatus: member.status,
        },
        "Inbound voice ACL: known but unverified caller — returning verification guidance",
      );
      return {
        outcome: {
          action: "unverified_caller",
          assistantId,
          fromNumber: ctx.from,
          displayName: member.contact.displayName,
          isGuardian: member.role === "guardian",
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
  if (actorTrust.memberRecord?.policy === "deny") {
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
  if (actorTrust.memberRecord?.policy === "escalate") {
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

  // Admission floor: deny member/guardian callers below the floor (e.g.
  // `guardian_only` denies a trusted_contact).
  if (!floorVerdict.admitted) {
    return floorDeny(floorVerdict);
  }

  // Guardian and trusted-contact callers proceed normally
  return {
    outcome: { action: "normal_call", isInbound: true },
    resolved,
  };
}
