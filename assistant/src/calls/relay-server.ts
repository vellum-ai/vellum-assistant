/**
 * WebSocket handler for Twilio ConversationRelay protocol.
 *
 * Manages real-time voice conversations over WebSocket. Each active call
 * has a single RelayConnection instance that processes inbound messages
 * from Twilio and can send text tokens back for TTS.
 */

import { randomInt } from "node:crypto";

import type { ServerWebSocket } from "bun";

import { getConfig } from "../config/loader.js";
import { resolveUserReference } from "../config/user-reference.js";
import {
  findGuardianForChannel,
  listGuardianChannels,
} from "../contacts/contact-store.js";
import {
  createGuardianBinding,
  revokeGuardianBinding,
  touchContactInteraction,
  upsertMember,
} from "../contacts/contacts-write.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import { getCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import * as conversationStore from "../memory/conversation-store.js";
import { findActiveVoiceInvites } from "../memory/invite-store.js";
import { revokeScopedApprovalGrantsForContext } from "../memory/scoped-approval-grants.js";
import { notifyGuardianOfAccessRequest } from "../runtime/access-request-helper.js";
import {
  resolveActorTrust,
  toTrustContext,
} from "../runtime/actor-trust-resolver.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import {
  getGuardianBinding,
  getPendingChallenge,
  validateAndConsumeChallenge,
} from "../runtime/channel-guardian-service.js";
import {
  composeVerificationVoice,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/guardian-verification-templates.js";
import { redeemVoiceInviteCode } from "../runtime/invite-service.js";
import { parseJsonSafe } from "../util/json.js";
import { getLogger } from "../util/logger.js";
import {
  getAccessRequestPollIntervalMs,
  getTtsPlaybackDelayMs,
  getUserConsultationTimeoutMs,
} from "./call-constants.js";
import { CallController } from "./call-controller.js";
import { addPointerMessage, formatDuration } from "./call-pointer-messages.js";
import { fireCallTranscriptNotifier } from "./call-state.js";
import { isTerminalState } from "./call-state-machine.js";
import {
  getCallSession,
  recordCallEvent,
  updateCallSession,
} from "./call-store.js";
import { finalizeCall } from "./finalize-call.js";
import {
  classifyWaitUtterance,
  emitAccessRequestCallbackHandoff,
  getHeartbeatMessage,
  scheduleNextHeartbeat,
} from "./relay-access-wait.js";
import {
  extractPromptSpeakerMetadata,
  type PromptSpeakerContext,
  SpeakerIdentityTracker,
} from "./speaker-identification.js";

const log = getLogger("relay-server");

// ── ConversationRelay message types ──────────────────────────────────

// Messages FROM Twilio
export interface RelaySetupMessage {
  type: "setup";
  callSid: string;
  from: string;
  to: string;
  customParameters?: Record<string, string>;
}

export interface RelayPromptMessage {
  type: "prompt";
  voicePrompt: string;
  lang: string;
  last: boolean;
  speakerId?: string;
  speakerLabel?: string;
  speakerName?: string;
  speakerConfidence?: number;
  participantId?: string;
  participant?: {
    id?: string;
    name?: string;
  };
  speaker?: {
    id?: string;
    label?: string;
    name?: string;
    confidence?: number;
  };
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface RelayInterruptMessage {
  type: "interrupt";
  utteranceUntilInterrupt: string;
}

export interface RelayDtmfMessage {
  type: "dtmf";
  digit: string;
}

export interface RelayErrorMessage {
  type: "error";
  description: string;
}

export type RelayInboundMessage =
  | RelaySetupMessage
  | RelayPromptMessage
  | RelayInterruptMessage
  | RelayDtmfMessage
  | RelayErrorMessage;

// Messages TO Twilio
export interface RelayTextMessage {
  type: "text";
  token: string;
  last: boolean;
}

export interface RelayEndMessage {
  type: "end";
  handoffData?: string;
}

// ── WebSocket data type ──────────────────────────────────────────────

export interface RelayWebSocketData {
  callSessionId: string;
}

// ── Module-level state ───────────────────────────────────────────────

/** Active relay connections keyed by callSessionId. */
export const activeRelayConnections = new Map<string, RelayConnection>();

/** Module-level broadcast function, set by the HTTP server during startup. */
let globalBroadcast:
  | ((msg: import("../daemon/ipc-contract.js").ServerMessage) => void)
  | undefined;

/** Register a broadcast function so RelayConnection can forward IPC events. */
export function setRelayBroadcast(
  fn: (msg: import("../daemon/ipc-contract.js").ServerMessage) => void,
): void {
  globalBroadcast = fn;
}

// ── RelayConnection ──────────────────────────────────────────────────

/**
 * Manages a single WebSocket connection for one call.
 */
export type RelayConnectionState =
  | "connected"
  | "verification_pending"
  | "awaiting_name"
  | "awaiting_guardian_decision"
  | "disconnecting";

export class RelayConnection {
  private ws: ServerWebSocket<RelayWebSocketData>;
  private callSessionId: string;
  private conversationHistory: Array<{
    role: "caller" | "assistant";
    text: string;
    timestamp: number;
    speaker?: PromptSpeakerContext;
  }>;
  private abortController: AbortController;
  private controller: CallController | null = null;
  private speakerIdentityTracker: SpeakerIdentityTracker;

  // Verification state (outbound callee verification)
  private connectionState: RelayConnectionState = "connected";
  private verificationCode: string | null = null;
  private verificationAttempts = 0;
  private verificationMaxAttempts = 3;
  private verificationCodeLength = 6;
  private dtmfBuffer = "";

  // Inbound voice guardian verification state
  private guardianVerificationActive = false;
  private guardianChallengeAssistantId: string | null = null;
  private guardianVerificationFromNumber: string | null = null;

  // Outbound guardian verification state (system calls the guardian)
  private outboundGuardianVerificationSessionId: string | null = null;

  // Inbound voice invite redemption state
  private inviteRedemptionActive = false;
  private inviteRedemptionAssistantId: string | null = null;
  private inviteRedemptionFromNumber: string | null = null;
  private inviteRedemptionCodeLength = 6;
  private inviteRedemptionFriendName: string | null = null;
  private inviteRedemptionGuardianName: string | null = null;

  // In-call guardian approval wait state (friend-initiated)
  private accessRequestWaitActive = false;
  private accessRequestId: string | null = null;
  private accessRequestAssistantId: string | null = null;
  private accessRequestFromNumber: string | null = null;
  private accessRequestPollTimer: ReturnType<typeof setInterval> | null = null;
  private accessRequestTimeoutTimer: ReturnType<typeof setTimeout> | null =
    null;
  private accessRequestCallerName: string | null = null;

  // Name capture timeout (unknown inbound callers)
  private nameCaptureTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  // Guardian wait heartbeat state
  private accessRequestHeartbeatTimer: ReturnType<typeof setTimeout> | null =
    null;
  private accessRequestWaitStartedAt: number = 0;
  private heartbeatSequence = 0;

  // In-wait prompt handling state
  private lastInWaitReplyAt = 0;
  private static readonly IN_WAIT_REPLY_COOLDOWN_MS = 3000;

  // Callback offer state (in-memory per-call)
  private callbackOfferMade = false;
  private callbackOptIn = false;
  private callbackHandoffNotified = false;

  constructor(ws: ServerWebSocket<RelayWebSocketData>, callSessionId: string) {
    this.ws = ws;
    this.callSessionId = callSessionId;
    this.conversationHistory = [];
    this.abortController = new AbortController();
    this.speakerIdentityTracker = new SpeakerIdentityTracker();
  }

  /**
   * Get the verification code for this connection (if verification is active).
   */
  getVerificationCode(): string | null {
    return this.verificationCode;
  }

  /**
   * Whether inbound guardian voice verification is currently active.
   */
  isGuardianVerificationActive(): boolean {
    return this.guardianVerificationActive;
  }

  /**
   * Get the current connection state.
   */
  getConnectionState(): RelayConnectionState {
    return this.connectionState;
  }

  /**
   * Handle an inbound message from Twilio via the ConversationRelay WebSocket.
   */
  async handleMessage(data: string): Promise<void> {
    const parsed = parseJsonSafe<RelayInboundMessage>(data);
    if (!parsed) {
      log.warn(
        { callSessionId: this.callSessionId, data },
        "Failed to parse relay message",
      );
      return;
    }

    switch (parsed.type) {
      case "setup":
        await this.handleSetup(parsed);
        break;
      case "prompt":
        await this.handlePrompt(parsed);
        break;
      case "interrupt":
        this.handleInterrupt(parsed);
        break;
      case "dtmf":
        this.handleDtmf(parsed);
        break;
      case "error":
        this.handleError(parsed);
        break;
      default:
        log.warn(
          {
            callSessionId: this.callSessionId,
            type: (parsed as { type: unknown }).type,
          },
          "Unknown relay message type",
        );
    }
  }

  /**
   * Send a text token to the caller for TTS playback.
   */
  sendTextToken(token: string, last: boolean): void {
    const message: RelayTextMessage = { type: "text", token, last };
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Failed to send text token",
      );
    }
  }

  /**
   * End the ConversationRelay session.
   */
  endSession(reason?: string): void {
    const message: RelayEndMessage = { type: "end" };
    if (reason) {
      message.handoffData = JSON.stringify({ reason });
    }
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Failed to send end message",
      );
    }
  }

  /**
   * Get the conversation history for context.
   */
  getConversationHistory(): Array<{
    role: string;
    text: string;
    speaker?: PromptSpeakerContext;
  }> {
    return this.conversationHistory.map(({ role, text, speaker }) => ({
      role,
      text,
      speaker,
    }));
  }

  /**
   * Get the call session ID for this connection.
   */
  getCallSessionId(): string {
    return this.callSessionId;
  }

  /**
   * Set the controller for this connection.
   */
  setController(controller: CallController): void {
    this.controller = controller;
  }

  /**
   * Get the controller for this connection.
   */
  getController(): CallController | null {
    return this.controller;
  }

  /**
   * Clean up resources on disconnect.
   */
  destroy(): void {
    if (this.controller) {
      this.controller.destroy();
      this.controller = null;
    }
    if (this.accessRequestPollTimer) {
      clearInterval(this.accessRequestPollTimer);
      this.accessRequestPollTimer = null;
    }
    if (this.accessRequestTimeoutTimer) {
      clearTimeout(this.accessRequestTimeoutTimer);
      this.accessRequestTimeoutTimer = null;
    }
    if (this.accessRequestHeartbeatTimer) {
      clearTimeout(this.accessRequestHeartbeatTimer);
      this.accessRequestHeartbeatTimer = null;
    }
    if (this.nameCaptureTimeoutTimer) {
      clearTimeout(this.nameCaptureTimeoutTimer);
      this.nameCaptureTimeoutTimer = null;
    }
    this.accessRequestWaitActive = false;
    this.abortController.abort();
    log.info(
      { callSessionId: this.callSessionId },
      "RelayConnection destroyed",
    );
  }

  /**
   * Handle transport-level close from the relay websocket.
   *
   * Twilio status callbacks are best-effort; if they are delayed or absent,
   * we still finalize the call lifecycle from the relay close signal.
   */
  handleTransportClosed(code?: number, reason?: string): void {
    // If the call was still in guardian-wait with callback opt-in, emit the
    // handoff notification before cleaning up wait state.
    if (this.accessRequestWaitActive && this.callbackOptIn) {
      this.emitAccessRequestCallbackHandoffForReason("transport_closed");
    }

    // Clean up access request wait state on disconnect to stop polling
    this.clearAccessRequestWait();
    if (this.nameCaptureTimeoutTimer) {
      clearTimeout(this.nameCaptureTimeoutTimer);
      this.nameCaptureTimeoutTimer = null;
    }

    const session = getCallSession(this.callSessionId);
    if (!session) return;
    if (isTerminalState(session.status)) return;

    const isNormalClose = code === 1000;
    if (isNormalClose) {
      updateCallSession(this.callSessionId, {
        status: "completed",
        endedAt: Date.now(),
      });
      recordCallEvent(this.callSessionId, "call_ended", {
        reason: reason || "relay_closed",
        closeCode: code,
      });

      // Post a pointer message in the initiating conversation
      if (session.initiatedFromConversationId) {
        const durationMs = session.startedAt
          ? Date.now() - session.startedAt
          : 0;
        addPointerMessage(
          session.initiatedFromConversationId,
          "completed",
          session.toNumber,
          {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          },
        ).catch((err) => {
          log.warn(
            { conversationId: session.initiatedFromConversationId, err },
            "Skipping pointer write — origin conversation may no longer exist",
          );
        });
      }
    } else {
      const detail =
        reason || (code ? `relay_closed_${code}` : "relay_closed_abnormal");
      updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: `Relay websocket closed unexpectedly: ${detail}`,
      });
      recordCallEvent(this.callSessionId, "call_failed", {
        reason: detail,
        closeCode: code,
      });

      // Post a failure pointer message in the initiating conversation
      if (session.initiatedFromConversationId) {
        addPointerMessage(
          session.initiatedFromConversationId,
          "failed",
          session.toNumber,
          {
            reason: detail,
          },
        ).catch((err) => {
          log.warn(
            { conversationId: session.initiatedFromConversationId, err },
            "Skipping pointer write — origin conversation may no longer exist",
          );
        });
      }
    }

    // Revoke any scoped approval grants bound to this call session.
    // Revoke by both callSessionId and conversationId because the
    // guardian-approval-interception minting path sets callSessionId: null
    // but always sets conversationId.
    try {
      revokeScopedApprovalGrantsForContext({
        callSessionId: this.callSessionId,
      });
      revokeScopedApprovalGrantsForContext({
        conversationId: session.conversationId,
      });
    } catch (err) {
      log.warn(
        { err, callSessionId: this.callSessionId },
        "Failed to revoke scoped grants on transport close",
      );
    }

    finalizeCall(this.callSessionId, session.conversationId);
  }

  // ── Private handlers ─────────────────────────────────────────────

  private async handleSetup(msg: RelaySetupMessage): Promise<void> {
    log.info(
      {
        callSessionId: this.callSessionId,
        callSid: msg.callSid,
        from: msg.from,
        to: msg.to,
      },
      "ConversationRelay setup received",
    );

    // Store the callSid association on the call session
    const session = getCallSession(this.callSessionId);
    if (session) {
      const updates: Parameters<typeof updateCallSession>[1] = {
        providerCallSid: msg.callSid,
      };
      if (
        !isTerminalState(session.status) &&
        session.status !== "in_progress" &&
        session.status !== "waiting_on_user"
      ) {
        updates.status = "in_progress";
        if (!session.startedAt) {
          updates.startedAt = Date.now();
        }
      }
      updateCallSession(this.callSessionId, updates);
    }

    // Omit potentially sensitive keys from customParameters before persisting
    // to the call_events table. Only allow known-safe keys through.
    const safeCustomParameters = msg.customParameters
      ? Object.fromEntries(
          Object.entries(msg.customParameters).filter(
            ([key]) => !key.toLowerCase().includes("secret"),
          ),
        )
      : undefined;

    recordCallEvent(this.callSessionId, "call_connected", {
      callSid: msg.callSid,
      from: msg.from,
      to: msg.to,
      customParameters: safeCustomParameters,
    });

    // Inbound calls skip callee verification — verification is an
    // outbound-call concern where we need to confirm the callee's identity.
    // We use initiatedFromConversationId rather than task == null because
    // outbound calls always have an initiating conversation, while inbound
    // calls (created via createInboundVoiceSession) never do. Relying on
    // task == null is unreliable: task-less outbound sessions would
    // incorrectly bypass outbound verification.
    const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
    const isInbound = session?.initiatedFromConversationId == null;

    // Create and attach the session-backed voice controller. Seed guardian
    // actor context from the other party's identity + active binding so
    // first-turn behavior matches channel ingress semantics. For inbound
    // calls msg.from is the caller; for outbound calls msg.to is the
    // recipient (msg.from is the assistant's Twilio number).
    const otherPartyNumber = isInbound ? msg.from : msg.to;
    const initialActorTrust = resolveActorTrust({
      assistantId,
      sourceChannel: "voice",
      conversationExternalId: otherPartyNumber,
      actorExternalId: otherPartyNumber || undefined,
    });
    const initialTrustContext = toTrustContext(
      initialActorTrust,
      otherPartyNumber,
    );

    const controller = new CallController(
      this.callSessionId,
      this,
      session?.task ?? null,
      {
        broadcast: globalBroadcast,
        assistantId,
        trustContext: initialTrustContext,
      },
    );
    this.setController(controller);

    // Detect outbound guardian verification call from persisted call session
    // mode first (deterministic source of truth), with setup custom parameter
    // as secondary signal for backward compatibility and observability.
    const persistedMode = session?.callMode;
    const persistedGvSessionId = session?.guardianVerificationSessionId;
    const customParamGvSessionId =
      msg.customParameters?.guardianVerificationSessionId;
    const guardianVerificationSessionId =
      persistedGvSessionId ?? customParamGvSessionId;

    if (
      persistedMode === "guardian_verification" &&
      guardianVerificationSessionId
    ) {
      this.startOutboundGuardianVerification(
        assistantId,
        guardianVerificationSessionId,
        msg.to,
      );
      return;
    }

    // Secondary signal: custom parameter without persisted mode (pre-migration sessions)
    if (!persistedMode && customParamGvSessionId) {
      log.warn(
        {
          callSessionId: this.callSessionId,
          guardianVerificationSessionId: customParamGvSessionId,
        },
        "Guardian verification detected via setup custom parameter (no persisted call_mode) — entering verification path",
      );
      this.startOutboundGuardianVerification(
        assistantId,
        customParamGvSessionId,
        msg.to,
      );
      return;
    }

    const config = getConfig();
    const verificationConfig = config.calls.verification;
    if (!isInbound && verificationConfig.enabled) {
      await this.startVerification(session, verificationConfig);
    } else if (isInbound) {
      // ── Trusted-contact ACL enforcement for inbound voice ──
      // Resolve the caller's trust classification before allowing the call
      // to proceed. Guardian and trusted-contact callers pass through;
      // unknown callers are denied with deterministic voice copy and an
      // access request is created for the guardian — unless there is a
      // pending voice guardian challenge, in which case the caller is
      // expected to be unknown (no binding yet) and should enter the
      // verification flow.
      const actorTrust = resolveActorTrust({
        assistantId,
        sourceChannel: "voice",
        conversationExternalId: msg.from,
        actorExternalId: msg.from || undefined,
      });

      // Check for a pending voice guardian challenge before the ACL deny
      // gate. An unknown caller with a pending challenge is expected —
      // they need to complete verification to establish a binding.
      const pendingChallenge = getPendingChallenge(assistantId, "voice");

      if (actorTrust.trustClass === "unknown" && !pendingChallenge) {
        // Before entering the name capture flow, check if there is an
        // active voice invite bound to the caller's phone number. If so,
        // enter the invite redemption subflow instead.
        let voiceInvites: ReturnType<typeof findActiveVoiceInvites> = [];
        try {
          voiceInvites = findActiveVoiceInvites({
            assistantId,
            expectedExternalUserId: msg.from,
          });
        } catch (err) {
          log.warn(
            { err, callSessionId: this.callSessionId },
            "Failed to check voice invites for unknown caller",
          );
        }

        // Exclude invites that are past their expiresAt even if the DB
        // status hasn't been lazily flipped to 'expired' yet.
        const now = Date.now();
        const nonExpiredInvites = voiceInvites.filter(
          (i) => !i.expiresAt || i.expiresAt > now,
        );

        // Blocked members get immediate denial — the guardian already made
        // an explicit decision to block them. This must be checked before
        // invite redemption so a blocked caller cannot bypass the block by
        // redeeming an active invite.
        if (actorTrust.memberRecord?.channel.status === "blocked") {
          log.info(
            {
              callSessionId: this.callSessionId,
              from: msg.from,
              trustClass: actorTrust.trustClass,
            },
            "Inbound voice ACL: blocked caller denied",
          );

          recordCallEvent(this.callSessionId, "inbound_acl_denied", {
            from: msg.from,
            trustClass: actorTrust.trustClass,
            denialReason: actorTrust.denialReason,
          });

          this.sendTextToken(
            "This number is not authorized to use this assistant.",
            true,
          );

          this.connectionState = "disconnecting";

          updateCallSession(this.callSessionId, {
            status: "failed",
            endedAt: Date.now(),
            lastError: "Inbound voice ACL: caller blocked",
          });

          setTimeout(() => {
            this.endSession("Inbound voice ACL denied — blocked");
          }, getTtsPlaybackDelayMs());
          return;
        }

        if (nonExpiredInvites.length > 0) {
          // Use the first matching invite's metadata for personalized prompts
          const matchedInvite = nonExpiredInvites[0];
          log.info(
            { callSessionId: this.callSessionId, from: msg.from },
            "Inbound voice ACL: unknown caller has active voice invite — entering redemption flow",
          );
          this.startInviteRedemption(
            assistantId,
            msg.from,
            matchedInvite.friendName,
            matchedInvite.guardianName,
          );
          return;
        }

        // Unknown/revoked/pending callers enter the name capture + guardian
        // approval wait flow instead of being hard-rejected.
        log.info(
          {
            callSessionId: this.callSessionId,
            from: msg.from,
            trustClass: actorTrust.trustClass,
          },
          "Inbound voice ACL: unknown caller — entering name capture flow",
        );

        recordCallEvent(
          this.callSessionId,
          "inbound_acl_name_capture_started",
          {
            from: msg.from,
            trustClass: actorTrust.trustClass,
          },
        );

        this.startNameCapture(assistantId, msg.from);
        return;
      }

      // Members with policy: 'deny' have status: 'active' so resolveActorTrust
      // classifies them as trusted_contact, but the guardian has explicitly
      // denied their access. Block them the same way the text-channel path does.
      if (actorTrust.memberRecord?.channel.policy === "deny") {
        log.info(
          {
            callSessionId: this.callSessionId,
            from: msg.from,
            channelId: actorTrust.memberRecord.channel.id,
            trustClass: actorTrust.trustClass,
          },
          "Inbound voice ACL: member policy deny",
        );

        recordCallEvent(this.callSessionId, "inbound_acl_denied", {
          from: msg.from,
          trustClass: actorTrust.trustClass,
          channelId: actorTrust.memberRecord.channel.id,
          memberPolicy: actorTrust.memberRecord.channel.policy,
        });

        this.sendTextToken(
          "This number is not authorized to use this assistant.",
          true,
        );

        this.connectionState = "disconnecting";

        updateCallSession(this.callSessionId, {
          status: "failed",
          endedAt: Date.now(),
          lastError: "Inbound voice ACL: member policy deny",
        });

        setTimeout(() => {
          this.endSession("Inbound voice ACL: member policy deny");
        }, getTtsPlaybackDelayMs());
        return;
      }

      // Members with policy: 'escalate' require guardian approval, but a live
      // voice call cannot be paused for async approval. Fail-closed by denying
      // the call with an appropriate message — mirrors the deny block above.
      if (actorTrust.memberRecord?.channel.policy === "escalate") {
        log.info(
          {
            callSessionId: this.callSessionId,
            from: msg.from,
            channelId: actorTrust.memberRecord.channel.id,
            trustClass: actorTrust.trustClass,
          },
          "Inbound voice ACL: member policy escalate — cannot hold live call for guardian approval",
        );

        recordCallEvent(this.callSessionId, "inbound_acl_denied", {
          from: msg.from,
          trustClass: actorTrust.trustClass,
          channelId: actorTrust.memberRecord.channel.id,
          memberPolicy: actorTrust.memberRecord.channel.policy,
        });

        this.sendTextToken(
          "This number requires guardian approval for calls. Please have the account guardian update your permissions.",
          true,
        );

        this.connectionState = "disconnecting";

        updateCallSession(this.callSessionId, {
          status: "failed",
          endedAt: Date.now(),
          lastError:
            "Inbound voice ACL: member policy escalate — voice calls cannot await guardian approval",
        });

        setTimeout(() => {
          this.endSession("Inbound voice ACL: member policy escalate");
        }, getTtsPlaybackDelayMs());
        return;
      }

      // Guardian and trusted-contact callers proceed normally.
      if (actorTrust.memberRecord) {
        touchContactInteraction(actorTrust.memberRecord.contact.id);
      }

      // Update the controller's guardian context with the trust-resolved
      // context so downstream policy gates have accurate actor metadata.
      if (this.controller && actorTrust.trustClass !== "unknown") {
        const resolvedTrustContext = toTrustContext(actorTrust, msg.from);
        this.controller.setTrustContext(resolvedTrustContext);
      }

      if (pendingChallenge) {
        this.startInboundGuardianVerification(assistantId, msg.from);
      } else {
        this.startNormalCallFlow(controller, true);
      }
    } else {
      this.startNormalCallFlow(controller, false);
    }
  }

  /**
   * Generate a verification code and prompt the callee to enter it via DTMF.
   */
  private async startVerification(
    session: ReturnType<typeof getCallSession>,
    verificationConfig: { maxAttempts: number; codeLength: number },
  ): Promise<void> {
    this.verificationMaxAttempts = verificationConfig.maxAttempts;
    this.verificationCodeLength = verificationConfig.codeLength;
    this.verificationAttempts = 0;
    this.dtmfBuffer = "";

    // Generate a random numeric code
    const maxValue = Math.pow(10, this.verificationCodeLength);
    const code = randomInt(0, maxValue)
      .toString()
      .padStart(this.verificationCodeLength, "0");
    this.verificationCode = code;
    this.connectionState = "verification_pending";

    recordCallEvent(this.callSessionId, "callee_verification_started", {
      codeLength: this.verificationCodeLength,
      maxAttempts: this.verificationMaxAttempts,
    });

    // Send a TTS prompt with the code spoken digit by digit
    const spokenCode = code.split("").join(". ");
    this.sendTextToken(
      `Please enter the verification code: ${spokenCode}.`,
      true,
    );

    // Post the verification code to the initiating conversation so the
    // guardian (user) can share it with the callee.
    if (session?.initiatedFromConversationId) {
      const codeMsg = `\u{1F510} Verification code for call to ${session.toNumber}: ${code}`;
      await conversationStore.addMessage(
        session.initiatedFromConversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: codeMsg }]),
        {
          userMessageChannel: "voice",
          assistantMessageChannel: "voice",
          userMessageInterface: "voice",
          assistantMessageInterface: "voice",
        },
      );
    }

    log.info(
      {
        callSessionId: this.callSessionId,
        codeLength: this.verificationCodeLength,
      },
      "Callee verification started",
    );
  }

  /**
   * Start normal call flow — fire the controller greeting unless a
   * static welcome greeting is configured.
   */
  private startNormalCallFlow(
    controller: CallController,
    isInbound: boolean,
  ): void {
    const hasStaticGreeting = !!process.env.CALL_WELCOME_GREETING?.trim();
    if (!hasStaticGreeting) {
      controller
        .startInitialGreeting()
        .catch((err) =>
          log.error(
            { err, callSessionId: this.callSessionId },
            `Failed to start initial ${isInbound ? "inbound" : "outbound"} greeting`,
          ),
        );
    }
  }

  /**
   * Shared post-activation handoff for all trusted-contact success paths
   * (access-request approval, invite redemption, verification code).
   * Activates the caller, updates guardian context, delivers deterministic
   * transition copy, and marks the next utterance as opening-ack so the
   * LLM continues naturally.
   */
  private continueCallAfterTrustedContactActivation(params: {
    assistantId: string;
    fromNumber: string;
    callerName?: string;
    skipMemberActivation?: boolean;
  }): void {
    const { assistantId, fromNumber, callerName } = params;

    if (!params.skipMemberActivation) {
      try {
        upsertMember({
          assistantId,
          sourceChannel: "voice",
          externalUserId: fromNumber,
          externalChatId: fromNumber,
          displayName: callerName,
          status: "active",
          policy: "allow",
        });
      } catch (err) {
        log.error(
          { err, callSessionId: this.callSessionId },
          "Failed to activate voice caller as trusted contact",
        );
      }
    }

    const updatedTrust = resolveActorTrust({
      assistantId,
      sourceChannel: "voice",
      conversationExternalId: fromNumber,
      actorExternalId: fromNumber,
    });

    if (this.controller) {
      this.controller.setTrustContext(toTrustContext(updatedTrust, fromNumber));
    }

    this.connectionState = "connected";
    updateCallSession(this.callSessionId, { status: "in_progress" });

    const guardianLabel = this.resolveGuardianLabel();
    const handoffText = `Great! ${guardianLabel} said I can speak with you. How can I help?`;
    this.sendTextToken(handoffText, true);

    recordCallEvent(this.callSessionId, "assistant_spoke", {
      text: handoffText,
    });
    const session = getCallSession(this.callSessionId);
    if (session) {
      fireCallTranscriptNotifier(
        session.conversationId,
        this.callSessionId,
        "assistant",
        handoffText,
      );
    }

    if (this.controller) {
      this.controller.markNextCallerTurnAsOpeningAck();
    }
  }

  /**
   * Enter verification-pending state for an inbound call with a pending
   * voice guardian challenge. Prompts the caller to enter their six-digit
   * verification code via DTMF or by speaking it.
   */
  private startInboundGuardianVerification(
    assistantId: string,
    fromNumber: string,
  ): void {
    this.guardianVerificationActive = true;
    this.guardianChallengeAssistantId = assistantId;
    this.guardianVerificationFromNumber = fromNumber;
    this.connectionState = "verification_pending";
    this.verificationAttempts = 0;
    this.verificationMaxAttempts = 3;
    this.verificationCodeLength = 6;
    this.dtmfBuffer = "";

    recordCallEvent(this.callSessionId, "guardian_voice_verification_started", {
      assistantId,
      maxAttempts: this.verificationMaxAttempts,
    });

    this.sendTextToken(
      "Welcome. Please enter your six-digit verification code using your keypad, or speak the digits now.",
      true,
    );

    log.info(
      { callSessionId: this.callSessionId, assistantId },
      "Inbound guardian voice verification started",
    );
  }

  /**
   * Enter verification-pending state for an outbound guardian verification
   * call. The system called the guardian's phone; prompt them to enter the
   * verification code via DTMF or speech.
   */
  private startOutboundGuardianVerification(
    assistantId: string,
    guardianVerificationSessionId: string,
    toNumber: string,
  ): void {
    this.guardianVerificationActive = true;
    this.outboundGuardianVerificationSessionId = guardianVerificationSessionId;
    this.guardianChallengeAssistantId = assistantId;
    // For outbound guardian calls, the "to" number is the guardian's phone
    this.guardianVerificationFromNumber = toNumber;
    this.connectionState = "verification_pending";
    this.verificationAttempts = 0;
    this.verificationMaxAttempts = 3;
    this.verificationCodeLength = 6;
    this.dtmfBuffer = "";

    recordCallEvent(
      this.callSessionId,
      "outbound_guardian_voice_verification_started",
      {
        assistantId,
        guardianVerificationSessionId,
        maxAttempts: this.verificationMaxAttempts,
      },
    );

    const introText = composeVerificationVoice(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_CALL_INTRO,
      { codeDigits: this.verificationCodeLength },
    );
    this.sendTextToken(introText, true);

    log.info(
      {
        callSessionId: this.callSessionId,
        assistantId,
        guardianVerificationSessionId,
      },
      "Outbound guardian voice verification started",
    );
  }

  /**
   * Extract digit characters from a speech transcript. Recognizes both
   * raw digit characters ("1 2 3") and spoken number words ("one two three").
   */
  private static parseDigitsFromSpeech(transcript: string): string {
    const wordToDigit: Record<string, string> = {
      zero: "0",
      oh: "0",
      o: "0",
      one: "1",
      won: "1",
      two: "2",
      too: "2",
      to: "2",
      three: "3",
      four: "4",
      for: "4",
      fore: "4",
      five: "5",
      six: "6",
      seven: "7",
      eight: "8",
      ate: "8",
      nine: "9",
    };

    const digits: string[] = [];
    const lower = transcript.toLowerCase();

    // Split on whitespace and non-alphanumeric boundaries
    const tokens = lower.split(/[\s,.\-;:!?]+/);
    for (const token of tokens) {
      if (/^\d$/.test(token)) {
        digits.push(token);
      } else if (wordToDigit[token]) {
        digits.push(wordToDigit[token]);
      } else if (/^\d+$/.test(token)) {
        // Multi-digit number like "123456" — split into individual digits
        digits.push(...token.split(""));
      }
    }

    return digits.join("");
  }

  /**
   * Attempt to validate an entered code against the pending voice guardian
   * challenge via validateAndConsumeChallenge. On success, binds the
   * guardian and transitions appropriately:
   *   - Inbound: transitions to normal call flow
   *   - Outbound: plays success template and ends the call
   * On failure, enforces max attempts and terminates the call if exhausted.
   */
  private attemptGuardianCodeVerification(enteredCode: string): void {
    if (
      !this.guardianChallengeAssistantId ||
      !this.guardianVerificationFromNumber
    ) {
      return;
    }

    const isOutbound = this.outboundGuardianVerificationSessionId != null;
    const codeDigits = this.verificationCodeLength;

    const result = validateAndConsumeChallenge(
      this.guardianChallengeAssistantId,
      "voice",
      enteredCode,
      this.guardianVerificationFromNumber,
      this.guardianVerificationFromNumber,
    );

    if (result.success) {
      this.connectionState = "connected";
      this.guardianVerificationActive = false;
      this.verificationAttempts = 0;
      this.dtmfBuffer = "";

      const eventName = isOutbound
        ? "outbound_guardian_voice_verification_succeeded"
        : "guardian_voice_verification_succeeded";

      recordCallEvent(this.callSessionId, eventName, {
        verificationType: result.verificationType,
      });
      log.info(
        { callSessionId: this.callSessionId, isOutbound },
        "Guardian voice verification succeeded",
      );

      // Create the guardian binding now that verification succeeded.
      if (result.verificationType === "guardian") {
        const existingBinding = getGuardianBinding(
          this.guardianChallengeAssistantId,
          "voice",
        );
        if (
          existingBinding &&
          existingBinding.guardianExternalUserId !==
            this.guardianVerificationFromNumber
        ) {
          log.warn(
            {
              callSessionId: this.callSessionId,
              existingGuardian: existingBinding.guardianExternalUserId,
            },
            "Guardian binding conflict: another user already holds the voice binding",
          );
        } else {
          revokeGuardianBinding(this.guardianChallengeAssistantId, "voice");

          // Unify all channel bindings onto the canonical (vellum) principal
          const vellumBinding = getGuardianBinding(
            this.guardianChallengeAssistantId,
            "vellum",
          );
          const canonicalPrincipal =
            vellumBinding?.guardianPrincipalId ??
            this.guardianVerificationFromNumber;

          createGuardianBinding({
            assistantId: this.guardianChallengeAssistantId,
            channel: "voice",
            guardianExternalUserId: this.guardianVerificationFromNumber,
            guardianDeliveryChatId: this.guardianVerificationFromNumber,
            guardianPrincipalId: canonicalPrincipal,
            verifiedVia: "challenge",
          });
        }
      }

      if (isOutbound) {
        // Outbound guardian verification: play success and hang up.
        // There is no normal conversation to transition to.
        // Set disconnecting to ignore any further DTMF/speech input
        // during the brief delay before the session ends.
        this.connectionState = "disconnecting";

        const successText = composeVerificationVoice(
          GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_SUCCESS,
          { codeDigits },
        );
        this.sendTextToken(successText, true);

        updateCallSession(this.callSessionId, {
          status: "completed",
          endedAt: Date.now(),
        });

        // Emit a pointer message to the origin conversation so the
        // requesting chat sees a deterministic completion notice.
        const successSession = getCallSession(this.callSessionId);
        if (successSession?.initiatedFromConversationId) {
          addPointerMessage(
            successSession.initiatedFromConversationId,
            "guardian_verification_succeeded",
            successSession.toNumber,
            { channel: "voice" },
          ).catch((err) => {
            log.warn(
              {
                conversationId: successSession.initiatedFromConversationId,
                err,
              },
              "Skipping pointer write — origin conversation may no longer exist",
            );
          });
        }

        setTimeout(() => {
          this.endSession("Verified — guardian challenge passed");
        }, getTtsPlaybackDelayMs());
      } else if (result.verificationType === "trusted_contact") {
        // Inbound trusted-contact verification: activate and continue
        // the live call with the shared handoff primitive.
        this.continueCallAfterTrustedContactActivation({
          assistantId: this.guardianChallengeAssistantId,
          fromNumber: this.guardianVerificationFromNumber,
        });
      } else {
        // Inbound guardian verification: create/update binding, then proceed
        // to normal call flow. Mirrors the binding creation logic in
        // verification-intercept.ts for the inbound channel path.
        const guardianAssistantId = this.guardianChallengeAssistantId;
        const callerNumber = this.guardianVerificationFromNumber;

        const existingBinding = getGuardianBinding(
          guardianAssistantId,
          "voice",
        );
        if (
          existingBinding &&
          existingBinding.guardianExternalUserId !== callerNumber
        ) {
          log.warn(
            {
              sourceChannel: "voice",
              existingGuardian: existingBinding.guardianExternalUserId,
            },
            "Guardian binding conflict: another user already holds the voice channel binding",
          );
        } else {
          revokeGuardianBinding(guardianAssistantId, "voice");

          // Resolve canonical principal from the vellum channel binding
          // so all channel bindings share a single principal identity.
          const vellumBinding = getGuardianBinding(
            guardianAssistantId,
            "vellum",
          );
          const canonicalPrincipal =
            vellumBinding?.guardianPrincipalId ?? callerNumber;

          createGuardianBinding({
            assistantId: guardianAssistantId,
            channel: "voice",
            guardianExternalUserId: callerNumber,
            guardianDeliveryChatId: callerNumber,
            guardianPrincipalId: canonicalPrincipal,
            verifiedVia: "challenge",
          });
        }

        if (this.controller) {
          const verifiedActorTrust = resolveActorTrust({
            assistantId: guardianAssistantId,
            sourceChannel: "voice",
            conversationExternalId: callerNumber,
            actorExternalId: callerNumber,
          });
          this.controller.setTrustContext(
            toTrustContext(verifiedActorTrust, callerNumber),
          );
          this.startNormalCallFlow(this.controller, true);
        }
      }
    } else {
      this.verificationAttempts++;

      if (this.verificationAttempts >= this.verificationMaxAttempts) {
        // Immediately deactivate verification so DTMF/speech input during
        // the goodbye window doesn't trigger more verification attempts.
        this.guardianVerificationActive = false;

        const failEventName = isOutbound
          ? "outbound_guardian_voice_verification_failed"
          : "guardian_voice_verification_failed";

        recordCallEvent(this.callSessionId, failEventName, {
          attempts: this.verificationAttempts,
        });
        log.warn(
          {
            callSessionId: this.callSessionId,
            attempts: this.verificationAttempts,
            isOutbound,
          },
          "Guardian voice verification failed — max attempts reached",
        );

        const failureText = isOutbound
          ? composeVerificationVoice(
              GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_FAILURE,
              { codeDigits },
            )
          : "Verification failed. Goodbye.";
        this.sendTextToken(failureText, true);

        updateCallSession(this.callSessionId, {
          status: "failed",
          endedAt: Date.now(),
          lastError:
            "Guardian voice verification failed — max attempts exceeded",
        });

        const failSession = getCallSession(this.callSessionId);
        if (failSession) {
          finalizeCall(this.callSessionId, failSession.conversationId);

          // Emit a pointer message to the origin conversation so the
          // requesting chat sees a deterministic failure notice.
          if (isOutbound && failSession.initiatedFromConversationId) {
            addPointerMessage(
              failSession.initiatedFromConversationId,
              "guardian_verification_failed",
              failSession.toNumber,
              {
                channel: "voice",
                reason: "Max verification attempts exceeded",
              },
            ).catch((err) => {
              log.warn(
                {
                  conversationId: failSession.initiatedFromConversationId,
                  err,
                },
                "Skipping pointer write — origin conversation may no longer exist",
              );
            });
          }
        }

        setTimeout(() => {
          this.endSession("Verification failed — challenge rejected");
        }, getTtsPlaybackDelayMs());
      } else {
        const retryText = isOutbound
          ? composeVerificationVoice(
              GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_RETRY,
              { codeDigits },
            )
          : "That code was incorrect. Please try again.";

        log.info(
          {
            callSessionId: this.callSessionId,
            attempt: this.verificationAttempts,
            maxAttempts: this.verificationMaxAttempts,
            isOutbound,
          },
          "Guardian voice verification attempt failed — retrying",
        );
        this.sendTextToken(retryText, true);
      }
    }
  }

  /**
   * Enter the invite redemption subflow for an inbound unknown caller
   * who has an active voice invite. Prompts the caller to enter their
   * invite code via DTMF or speech.
   */
  private startInviteRedemption(
    assistantId: string,
    fromNumber: string,
    friendName: string | null,
    guardianName: string | null,
  ): void {
    this.inviteRedemptionActive = true;
    this.inviteRedemptionAssistantId = assistantId;
    this.inviteRedemptionFromNumber = fromNumber;
    this.inviteRedemptionFriendName = friendName;
    this.inviteRedemptionGuardianName = guardianName;
    this.connectionState = "verification_pending";
    this.verificationAttempts = 0;
    this.verificationMaxAttempts = 1;
    this.inviteRedemptionCodeLength = 6;
    this.dtmfBuffer = "";

    recordCallEvent(this.callSessionId, "invite_redemption_started", {
      assistantId,
      codeLength: 6,
      maxAttempts: this.verificationMaxAttempts,
    });

    const displayFriend = friendName ?? "there";
    const displayGuardian = guardianName ?? "your contact";
    this.sendTextToken(
      `Welcome ${displayFriend}. Please enter the 6-digit code that ${displayGuardian} provided you to verify your identity.`,
      true,
    );

    log.info(
      { callSessionId: this.callSessionId, assistantId },
      "Inbound voice invite redemption started",
    );
  }

  /**
   * Enter the name capture subflow for unknown inbound callers.
   * Prompts the caller to provide their name so we can include it
   * in the guardian notification.
   */
  private startNameCapture(assistantId: string, fromNumber: string): void {
    this.accessRequestAssistantId = assistantId;
    this.accessRequestFromNumber = fromNumber;
    this.connectionState = "awaiting_name";

    const guardianLabel = this.resolveGuardianLabel();
    const assistantName = this.resolveAssistantLabel();

    const greeting = assistantName
      ? `Hi, this is ${assistantName}, ${guardianLabel}'s assistant. Sorry, I don't recognize this number. I'll let ${guardianLabel} know you called and see if I have permission to speak with you. Can I get your name?`
      : `Hi, this is ${guardianLabel}'s assistant. Sorry, I don't recognize this number. I'll let ${guardianLabel} know you called and see if I have permission to speak with you. Can I get your name?`;

    this.sendTextToken(greeting, true);

    // Start a timeout so silent callers don't keep the call open indefinitely.
    // Uses a 30-second window — enough time to speak a name but short enough
    // to avoid wasting resources on callers who never respond.
    const NAME_CAPTURE_TIMEOUT_MS = 30_000;
    this.nameCaptureTimeoutTimer = setTimeout(() => {
      if (this.connectionState !== "awaiting_name") return;
      this.handleNameCaptureTimeout();
    }, NAME_CAPTURE_TIMEOUT_MS);

    log.info(
      {
        callSessionId: this.callSessionId,
        assistantId,
        timeoutMs: NAME_CAPTURE_TIMEOUT_MS,
      },
      "Name capture started for unknown inbound caller",
    );
  }

  /**
   * Handle the caller's name response during the name capture subflow.
   * Creates a canonical access request, notifies the guardian, and
   * enters the bounded wait loop for the guardian decision.
   */
  private handleNameCaptureResponse(callerName: string): void {
    if (!this.accessRequestAssistantId || !this.accessRequestFromNumber) {
      return;
    }

    // Clear the name capture timeout since the caller responded.
    if (this.nameCaptureTimeoutTimer) {
      clearTimeout(this.nameCaptureTimeoutTimer);
      this.nameCaptureTimeoutTimer = null;
    }

    this.accessRequestCallerName = callerName;

    recordCallEvent(this.callSessionId, "inbound_acl_name_captured", {
      from: this.accessRequestFromNumber,
      callerName,
    });

    // Create canonical access request and notify the guardian, including
    // the caller's spoken name and voice channel metadata.
    try {
      const accessResult = notifyGuardianOfAccessRequest({
        canonicalAssistantId: this.accessRequestAssistantId,
        sourceChannel: "voice",
        conversationExternalId: this.accessRequestFromNumber,
        actorExternalId: this.accessRequestFromNumber,
        actorDisplayName: callerName,
      });

      if (accessResult.notified) {
        this.accessRequestId = accessResult.requestId;
        log.info(
          {
            callSessionId: this.callSessionId,
            requestId: accessResult.requestId,
            callerName,
          },
          "Guardian notified of voice access request with caller name",
        );
      } else {
        log.warn(
          { callSessionId: this.callSessionId },
          "Failed to notify guardian of voice access request — no sender ID",
        );
      }
    } catch (err) {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Failed to create access request for voice caller",
      );
    }

    // If the access request was not successfully created (notifyGuardianOfAccessRequest
    // threw or returned notified: false), fail closed rather than leaving the caller
    // stuck on hold with no guardian poll target.
    if (!this.accessRequestId) {
      log.warn(
        { callSessionId: this.callSessionId },
        "Access request ID is null after notification attempt — failing closed",
      );
      this.handleAccessRequestTimeout();
      return;
    }

    // Enter the bounded wait loop for the guardian decision
    this.startAccessRequestWait();
  }

  /**
   * Start a bounded in-call wait loop polling the canonical request
   * status until approved, denied, or timeout.
   */
  private startAccessRequestWait(): void {
    this.accessRequestWaitActive = true;
    this.connectionState = "awaiting_guardian_decision";

    const timeoutMs = getUserConsultationTimeoutMs();
    const pollIntervalMs = getAccessRequestPollIntervalMs();

    const guardianLabel = this.resolveGuardianLabel();
    this.sendTextToken(
      `Thank you. I've let ${guardianLabel} know. Please hold while I check if I have permission to speak with you.`,
      true,
    );

    updateCallSession(this.callSessionId, { status: "waiting_on_user" });

    // Start the heartbeat timer for periodic progress updates.
    // Delay the first heartbeat by the estimated TTS playback duration so
    // the initial hold message finishes before any heartbeat fires.
    this.heartbeatSequence = 0;
    // Set the wait start time now so scheduleNextHeartbeat() always has a
    // valid reference point — even if the TTS delay timer is cancelled early
    // (e.g. by handleWaitStatePrompt when the caller speaks during playback).
    // The callback below re-stamps it to exclude the TTS delay if it fires.
    this.accessRequestWaitStartedAt = Date.now();
    this.accessRequestHeartbeatTimer = setTimeout(() => {
      this.accessRequestWaitStartedAt = Date.now();
      this.scheduleNextHeartbeat();
    }, getTtsPlaybackDelayMs());

    // Poll the canonical request status
    this.accessRequestPollTimer = setInterval(() => {
      if (!this.accessRequestWaitActive || !this.accessRequestId) {
        this.clearAccessRequestWait();
        return;
      }

      const request = getCanonicalGuardianRequest(this.accessRequestId);
      if (!request) {
        return;
      }

      if (request.status === "approved") {
        this.handleAccessRequestApproved();
      } else if (request.status === "denied") {
        this.handleAccessRequestDenied();
      }
      // 'pending' continues polling; 'expired'/'cancelled' handled by timeout
    }, pollIntervalMs);

    // Timeout: give up waiting for the guardian
    this.accessRequestTimeoutTimer = setTimeout(() => {
      if (!this.accessRequestWaitActive) return;

      log.info(
        { callSessionId: this.callSessionId, requestId: this.accessRequestId },
        "Access request in-call wait timed out",
      );

      this.handleAccessRequestTimeout();
    }, timeoutMs);

    log.info(
      {
        callSessionId: this.callSessionId,
        requestId: this.accessRequestId,
        timeoutMs,
      },
      "Access request in-call wait started",
    );
  }

  /**
   * Clean up access request wait state (timers, flags).
   */
  private clearAccessRequestWait(): void {
    this.accessRequestWaitActive = false;
    if (this.accessRequestPollTimer) {
      clearInterval(this.accessRequestPollTimer);
      this.accessRequestPollTimer = null;
    }
    if (this.accessRequestTimeoutTimer) {
      clearTimeout(this.accessRequestTimeoutTimer);
      this.accessRequestTimeoutTimer = null;
    }
    if (this.accessRequestHeartbeatTimer) {
      clearTimeout(this.accessRequestHeartbeatTimer);
      this.accessRequestHeartbeatTimer = null;
    }
  }

  /**
   * Handle an approved access request: activate the caller as a trusted
   * contact, update runtime context, and continue with normal call flow.
   */
  private handleAccessRequestApproved(): void {
    this.clearAccessRequestWait();

    const assistantId = this.accessRequestAssistantId!;
    const fromNumber = this.accessRequestFromNumber!;
    const callerName = this.accessRequestCallerName;

    recordCallEvent(this.callSessionId, "inbound_acl_access_approved", {
      from: fromNumber,
      callerName,
      requestId: this.accessRequestId,
    });

    log.info(
      { callSessionId: this.callSessionId, from: fromNumber },
      "Access request approved — caller activated and continuing call",
    );

    this.continueCallAfterTrustedContactActivation({
      assistantId,
      fromNumber,
      callerName: callerName ?? undefined,
    });

    recordCallEvent(
      this.callSessionId,
      "inbound_acl_post_approval_handoff_spoken",
      {
        from: fromNumber,
      },
    );
  }

  /**
   * Handle a denied access request: deliver deterministic copy and hang up.
   */
  private handleAccessRequestDenied(): void {
    this.clearAccessRequestWait();

    const guardianLabel = this.resolveGuardianLabel();

    recordCallEvent(this.callSessionId, "inbound_acl_access_denied", {
      from: this.accessRequestFromNumber,
      requestId: this.accessRequestId,
    });

    this.sendTextToken(
      `Sorry, ${guardianLabel} says I'm not allowed to speak with you. Goodbye.`,
      true,
    );

    this.connectionState = "disconnecting";

    updateCallSession(this.callSessionId, {
      status: "failed",
      endedAt: Date.now(),
      lastError: "Inbound voice ACL: guardian denied access request",
    });

    log.info(
      { callSessionId: this.callSessionId },
      "Access request denied — ending call",
    );

    setTimeout(() => {
      this.endSession("Access request denied");
    }, getTtsPlaybackDelayMs());
  }

  /**
   * Handle an access request timeout: deliver deterministic copy and hang up.
   */
  private handleAccessRequestTimeout(): void {
    // Emit callback handoff notification before clearing wait state
    this.emitAccessRequestCallbackHandoffForReason("timeout");

    this.clearAccessRequestWait();

    const guardianLabel = this.resolveGuardianLabel();

    recordCallEvent(this.callSessionId, "inbound_acl_access_timeout", {
      from: this.accessRequestFromNumber,
      requestId: this.accessRequestId,
      callbackOptIn: this.callbackOptIn,
    });

    const callbackNote = this.callbackOptIn
      ? ` I've noted that you'd like a callback — I'll pass that along to ${guardianLabel}.`
      : "";
    this.sendTextToken(
      `Sorry, I can't get ahold of ${guardianLabel} right now. I'll let them know you called.${callbackNote}`,
      true,
    );

    this.connectionState = "disconnecting";

    updateCallSession(this.callSessionId, {
      status: "failed",
      endedAt: Date.now(),
      lastError: "Inbound voice ACL: guardian approval wait timed out",
    });

    log.info(
      { callSessionId: this.callSessionId },
      "Access request timed out — ending call",
    );

    setTimeout(() => {
      this.endSession("Access request timed out");
    }, getTtsPlaybackDelayMs());
  }

  private emitAccessRequestCallbackHandoffForReason(
    reason: "timeout" | "transport_closed",
  ): void {
    const result = emitAccessRequestCallbackHandoff({
      reason,
      callbackOptIn: this.callbackOptIn,
      accessRequestId: this.accessRequestId,
      callbackHandoffNotified: this.callbackHandoffNotified,
      accessRequestAssistantId: this.accessRequestAssistantId,
      accessRequestFromNumber: this.accessRequestFromNumber,
      accessRequestCallerName: this.accessRequestCallerName,
      callSessionId: this.callSessionId,
    });
    this.callbackHandoffNotified = result.callbackHandoffNotified;
  }

  /**
   * Handle a name capture timeout: the caller never provided their name
   * within the allotted window. Deliver deterministic copy and hang up.
   */
  private handleNameCaptureTimeout(): void {
    if (this.nameCaptureTimeoutTimer) {
      clearTimeout(this.nameCaptureTimeoutTimer);
      this.nameCaptureTimeoutTimer = null;
    }

    recordCallEvent(this.callSessionId, "inbound_acl_name_capture_timeout", {
      from: this.accessRequestFromNumber,
    });

    this.sendTextToken(
      "Sorry, I didn't catch your name. Please try calling back. Goodbye.",
      true,
    );

    this.connectionState = "disconnecting";

    updateCallSession(this.callSessionId, {
      status: "failed",
      endedAt: Date.now(),
      lastError: "Inbound voice ACL: name capture timed out",
    });

    log.info(
      { callSessionId: this.callSessionId },
      "Name capture timed out — ending call",
    );

    setTimeout(() => {
      this.endSession("Name capture timed out");
    }, getTtsPlaybackDelayMs());
  }

  /**
   * Validate an entered invite code against active voice invites for the
   * caller. On success, create/activate the contact and transition
   * to the normal call flow. On failure, allow retries up to max attempts.
   */
  private attemptInviteCodeRedemption(enteredCode: string): void {
    if (!this.inviteRedemptionAssistantId || !this.inviteRedemptionFromNumber) {
      return;
    }

    const result = redeemVoiceInviteCode({
      assistantId: this.inviteRedemptionAssistantId,
      callerExternalUserId: this.inviteRedemptionFromNumber,
      sourceChannel: "voice",
      code: enteredCode,
    });

    if (result.ok) {
      this.inviteRedemptionActive = false;
      this.verificationAttempts = 0;
      this.dtmfBuffer = "";

      recordCallEvent(this.callSessionId, "invite_redemption_succeeded", {
        memberId: result.memberId,
        ...(result.type === "redeemed" ? { inviteId: result.inviteId } : {}),
      });
      log.info(
        {
          callSessionId: this.callSessionId,
          memberId: result.memberId,
          type: result.type,
        },
        "Voice invite redemption succeeded",
      );

      this.continueCallAfterTrustedContactActivation({
        assistantId: this.inviteRedemptionAssistantId,
        fromNumber: this.inviteRedemptionFromNumber,
        callerName: this.inviteRedemptionFriendName ?? undefined,
        skipMemberActivation: true,
      });
    } else {
      // On any invalid/expired code, emit exact deterministic failure copy and end call immediately.
      this.inviteRedemptionActive = false;

      recordCallEvent(this.callSessionId, "invite_redemption_failed", {
        attempts: 1,
      });
      log.warn(
        { callSessionId: this.callSessionId },
        "Voice invite redemption failed — invalid or expired code",
      );

      const displayGuardian =
        this.inviteRedemptionGuardianName ?? "your contact";
      this.sendTextToken(
        `Sorry, the code you provided is incorrect or has since expired. Please ask ${displayGuardian} for a new code. Goodbye.`,
        true,
      );

      this.connectionState = "disconnecting";

      updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: "Voice invite redemption failed — invalid or expired code",
      });

      const failSession = getCallSession(this.callSessionId);
      if (failSession) {
        finalizeCall(this.callSessionId, failSession.conversationId);
      }

      setTimeout(() => {
        this.endSession("Invite redemption failed");
      }, getTtsPlaybackDelayMs());
    }
  }

  // ── Guardian wait UX layer ─────────────────────────────────────

  /**
   * Resolve a human-readable guardian label for voice wait copy.
   * Prefers displayName from the guardian binding metadata, falls back
   * to @username, then the user's preferred name from USER.md.
   */
  private resolveGuardianLabel(): string {
    const assistantId =
      this.accessRequestAssistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;

    // Try the voice-channel binding first, then fall back to any active
    // binding for the assistant (mirrors the cross-channel fallback pattern
    // in access-request-helper.ts).
    let metadataJson: string | null = null;
    // Contacts-first: prefer the voice-bound guardian, then fall back to
    // any guardian channel (mirrors the voice-first pattern in the legacy path).
    const voiceGuardian = findGuardianForChannel("voice", assistantId);
    const guardianChannels = voiceGuardian
      ? null
      : listGuardianChannels(assistantId);
    const guardianContact = voiceGuardian?.contact ?? guardianChannels?.contact;
    if (guardianContact) {
      const meta: Record<string, string> = {};
      if (guardianContact.displayName) {
        meta.displayName = guardianContact.displayName;
      }
      // Preserve the username fallback: use the voice channel's externalUserId
      // so downstream parsing can fall back to @username when displayName is a
      // raw external ID (e.g., phone number from contact-sync).
      const voiceChannel =
        voiceGuardian?.channel ??
        guardianChannels?.channels.find((ch) => ch.type === "voice");
      if (voiceChannel?.externalUserId) {
        meta.username = voiceChannel.externalUserId;
      }
      if (Object.keys(meta).length > 0) {
        metadataJson = JSON.stringify(meta);
      }
    }
    if (!metadataJson) {
      const voiceBinding = getGuardianBinding(assistantId, "voice");
      if (voiceBinding?.metadataJson) {
        metadataJson = voiceBinding.metadataJson;
      }
    }

    if (metadataJson) {
      try {
        const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
        if (
          typeof parsed.displayName === "string" &&
          parsed.displayName.trim().length > 0
        ) {
          return parsed.displayName.trim();
        }
        if (
          typeof parsed.username === "string" &&
          parsed.username.trim().length > 0
        ) {
          return `@${parsed.username.trim()}`;
        }
      } catch {
        // ignore malformed metadata
      }
    }

    return resolveUserReference();
  }

  /**
   * Resolve the assistant's display name from identity configuration.
   * Returns the trimmed name or null if unavailable.
   */
  private resolveAssistantLabel(): string | null {
    try {
      const name = getAssistantName();
      return name?.trim() || null;
    } catch {
      return null;
    }
  }

  private getHeartbeatMessage(): string {
    const seq = this.heartbeatSequence++;
    return getHeartbeatMessage(seq, this.resolveGuardianLabel());
  }

  private scheduleNextHeartbeat(): void {
    this.accessRequestHeartbeatTimer = scheduleNextHeartbeat({
      accessRequestWaitActive: this.accessRequestWaitActive,
      accessRequestWaitStartedAt: this.accessRequestWaitStartedAt,
      callSessionId: this.callSessionId,
      consumeSequence: () => this.heartbeatSequence++,
      resolveGuardianLabel: () => this.resolveGuardianLabel(),
      sendTextToken: (text, last) => this.sendTextToken(text, last),
      scheduleNext: () => this.scheduleNextHeartbeat(),
    });
  }

  private classifyWaitUtterance(text: string) {
    return classifyWaitUtterance(text, this.callbackOfferMade);
  }

  /**
   * Handle a caller utterance during the guardian decision wait state.
   * Provides reassurance, impatience detection, and callback offer.
   */
  private handleWaitStatePrompt(text: string): void {
    const now = Date.now();
    const classification = this.classifyWaitUtterance(text);

    recordCallEvent(
      this.callSessionId,
      "voice_guardian_wait_prompt_classified",
      {
        classification,
        transcript: text,
      },
    );

    if (classification === "empty") return;

    const guardianLabel = this.resolveGuardianLabel();

    // Callback decisions must always be processed regardless of cooldown —
    // the caller is answering a direct question and dropping their response
    // would silently discard their decision.
    switch (classification) {
      case "callback_opt_in": {
        this.callbackOptIn = true;
        this.lastInWaitReplyAt = now;
        recordCallEvent(
          this.callSessionId,
          "voice_guardian_wait_callback_opt_in_set",
          {},
        );
        if (this.accessRequestHeartbeatTimer) {
          clearTimeout(this.accessRequestHeartbeatTimer);
          this.accessRequestHeartbeatTimer = null;
        }
        this.sendTextToken(
          `Noted, I'll make sure ${guardianLabel} knows you'd like a callback. For now, I'll keep trying to reach them.`,
          true,
        );
        this.scheduleNextHeartbeat();
        return;
      }
      case "callback_decline": {
        this.callbackOptIn = false;
        this.lastInWaitReplyAt = now;
        recordCallEvent(
          this.callSessionId,
          "voice_guardian_wait_callback_opt_in_declined",
          {},
        );
        if (this.accessRequestHeartbeatTimer) {
          clearTimeout(this.accessRequestHeartbeatTimer);
          this.accessRequestHeartbeatTimer = null;
        }
        this.sendTextToken(
          `No problem, I'll keep holding. Still waiting on ${guardianLabel}.`,
          true,
        );
        this.scheduleNextHeartbeat();
        return;
      }
      default:
        break;
    }

    // Enforce cooldown on non-callback utterances to prevent spam
    if (
      now - this.lastInWaitReplyAt <
      RelayConnection.IN_WAIT_REPLY_COOLDOWN_MS
    ) {
      log.debug(
        { callSessionId: this.callSessionId },
        "In-wait reply suppressed by cooldown",
      );
      return;
    }
    this.lastInWaitReplyAt = now;

    switch (classification) {
      case "impatient": {
        if (this.accessRequestHeartbeatTimer) {
          clearTimeout(this.accessRequestHeartbeatTimer);
          this.accessRequestHeartbeatTimer = null;
        }
        if (!this.callbackOfferMade) {
          this.callbackOfferMade = true;
          recordCallEvent(
            this.callSessionId,
            "voice_guardian_wait_callback_offer_sent",
            {},
          );
          this.sendTextToken(
            `I understand this is taking a while. I can have ${guardianLabel} call you back once I hear from them. Would you like that, or would you prefer to keep holding?`,
            true,
          );
        } else {
          // Already offered callback — just reassure
          this.sendTextToken(
            `I hear you, I'm sorry for the wait. Still trying to reach ${guardianLabel}.`,
            true,
          );
        }
        this.scheduleNextHeartbeat();
        break;
      }
      case "patience_check": {
        // Immediate reassurance — reset the heartbeat timer so we
        // don't double up with a scheduled heartbeat
        if (this.accessRequestHeartbeatTimer) {
          clearTimeout(this.accessRequestHeartbeatTimer);
          this.accessRequestHeartbeatTimer = null;
        }
        this.sendTextToken(
          `Yes, I'm still here. Still waiting to hear back from ${guardianLabel}.`,
          true,
        );
        this.scheduleNextHeartbeat();
        break;
      }
      case "neutral":
      default: {
        if (this.accessRequestHeartbeatTimer) {
          clearTimeout(this.accessRequestHeartbeatTimer);
          this.accessRequestHeartbeatTimer = null;
        }
        this.sendTextToken(
          `Thanks for that. I'm still waiting on ${guardianLabel}. I'll let you know as soon as I hear back.`,
          true,
        );
        this.scheduleNextHeartbeat();
        break;
      }
    }
  }

  private async handlePrompt(msg: RelayPromptMessage): Promise<void> {
    if (this.connectionState === "disconnecting") {
      return;
    }

    if (!msg.last) {
      // Partial transcript, wait for final
      return;
    }

    // During name capture, the caller's response is their name.
    if (this.connectionState === "awaiting_name") {
      const callerName = msg.voicePrompt.trim();
      if (!callerName) {
        // Whitespace-only or empty transcript (e.g. silence/noise) —
        // keep waiting for a real name. The name-capture timeout will
        // still fire if the caller never provides one.
        return;
      }
      log.info(
        { callSessionId: this.callSessionId, callerName },
        "Name captured from unknown inbound caller",
      );
      this.handleNameCaptureResponse(callerName);
      return;
    }

    // During guardian decision wait, classify caller speech for
    // reassurance, impatience detection, and callback offer.
    if (this.connectionState === "awaiting_guardian_decision") {
      this.handleWaitStatePrompt(msg.voicePrompt);
      return;
    }

    // During guardian verification (inbound or outbound), attempt to parse
    // spoken digits from the transcript and validate them.
    if (
      this.connectionState === "verification_pending" &&
      this.guardianVerificationActive
    ) {
      const spokenDigits = RelayConnection.parseDigitsFromSpeech(
        msg.voicePrompt,
      );
      log.info(
        {
          callSessionId: this.callSessionId,
          transcript: msg.voicePrompt,
          spokenDigits,
        },
        "Speech received during guardian voice verification",
      );
      if (spokenDigits.length >= this.verificationCodeLength) {
        const enteredCode = spokenDigits.slice(0, this.verificationCodeLength);
        this.attemptGuardianCodeVerification(enteredCode);
      } else if (spokenDigits.length > 0) {
        this.sendTextToken(
          `I heard ${spokenDigits.length} digits. Please enter all ${this.verificationCodeLength} digits of your code.`,
          true,
        );
      }
      return;
    }

    // During invite redemption, attempt to parse spoken digits from the
    // transcript and validate against the caller's active voice invite.
    if (
      this.connectionState === "verification_pending" &&
      this.inviteRedemptionActive
    ) {
      const spokenDigits = RelayConnection.parseDigitsFromSpeech(
        msg.voicePrompt,
      );
      log.info(
        {
          callSessionId: this.callSessionId,
          transcript: msg.voicePrompt,
          spokenDigits,
        },
        "Speech received during invite redemption",
      );
      if (spokenDigits.length >= this.inviteRedemptionCodeLength) {
        const enteredCode = spokenDigits.slice(
          0,
          this.inviteRedemptionCodeLength,
        );
        this.attemptInviteCodeRedemption(enteredCode);
      } else if (spokenDigits.length > 0) {
        this.sendTextToken(
          `I heard ${spokenDigits.length} digits. Please enter all ${this.inviteRedemptionCodeLength} digits of your code.`,
          true,
        );
      }
      return;
    }

    // During outbound callee verification, ignore voice prompts — the callee
    // should be entering DTMF digits, not speaking.
    if (this.connectionState === "verification_pending") {
      log.debug(
        { callSessionId: this.callSessionId },
        "Ignoring voice prompt during callee verification",
      );
      return;
    }

    log.info(
      {
        callSessionId: this.callSessionId,
        transcript: msg.voicePrompt,
        lang: msg.lang,
      },
      "Caller transcript received (final)",
    );

    // Spread to widen the typed message into a plain record — extractPromptSpeakerMetadata
    // probes for snake_case and nested property variants not on RelayPromptMessage.
    const speakerMetadata = extractPromptSpeakerMetadata({ ...msg });
    const speaker =
      this.speakerIdentityTracker.identifySpeaker(speakerMetadata);

    // Record in conversation history
    this.conversationHistory.push({
      role: "caller",
      text: msg.voicePrompt,
      timestamp: Date.now(),
      speaker,
    });

    // Record event
    recordCallEvent(this.callSessionId, "caller_spoke", {
      transcript: msg.voicePrompt,
      lang: msg.lang,
      speakerId: speaker.speakerId,
      speakerLabel: speaker.speakerLabel,
      speakerConfidence: speaker.speakerConfidence,
      speakerSource: speaker.source,
    });

    const session = getCallSession(this.callSessionId);
    if (session) {
      // User message persistence is handled by the session pipeline
      // (voice-session-bridge -> session.persistUserMessage) so we only
      // need to fire the transcript notifier for UI subscribers here.
      fireCallTranscriptNotifier(
        session.conversationId,
        this.callSessionId,
        "caller",
        msg.voicePrompt,
      );
    }

    // Route to controller for session-backed response
    if (this.controller) {
      await this.controller.handleCallerUtterance(msg.voicePrompt, speaker);
    } else {
      // Fallback if controller not yet initialized — persist the caller's
      // transcript so it is available in conversation history once setup
      // completes. The session pipeline normally handles persistence, but
      // this early-utterance path bypasses it entirely.
      if (session) {
        try {
          await conversationStore.addMessage(
            session.conversationId,
            "user",
            JSON.stringify([{ type: "text", text: msg.voicePrompt }]),
            {
              userMessageChannel: "voice",
              assistantMessageChannel: "voice",
              userMessageInterface: "voice",
              assistantMessageInterface: "voice",
            },
          );
        } catch (err) {
          // Best-effort — don't let persistence failures prevent the hold
          // response from reaching the caller.
          log.warn(
            { err, callSessionId: this.callSessionId },
            "Failed to persist early caller utterance",
          );
        }
      }
      this.sendTextToken("I'm still setting up. Please hold.", true);
    }
  }

  private handleInterrupt(msg: RelayInterruptMessage): void {
    log.info(
      {
        callSessionId: this.callSessionId,
        utteranceUntilInterrupt: msg.utteranceUntilInterrupt,
      },
      "Caller interrupted assistant",
    );

    // Abort any in-flight processing
    this.abortController.abort();
    this.abortController = new AbortController();

    // Notify the controller of the interruption
    if (this.controller) {
      this.controller.handleInterrupt();
    }
  }

  private handleDtmf(msg: RelayDtmfMessage): void {
    if (this.connectionState === "disconnecting") {
      return;
    }

    // Ignore DTMF during name capture and guardian decision wait
    if (
      this.connectionState === "awaiting_name" ||
      this.connectionState === "awaiting_guardian_decision"
    ) {
      return;
    }

    log.info(
      { callSessionId: this.callSessionId, digit: msg.digit },
      "DTMF digit received",
    );

    recordCallEvent(this.callSessionId, "caller_spoke", {
      dtmfDigit: msg.digit,
    });

    // If guardian verification (inbound or outbound) is pending, accumulate
    // digits and validate against the challenge via the guardian service.
    if (
      this.connectionState === "verification_pending" &&
      this.guardianVerificationActive
    ) {
      this.dtmfBuffer += msg.digit;

      if (this.dtmfBuffer.length >= this.verificationCodeLength) {
        const enteredCode = this.dtmfBuffer.slice(
          0,
          this.verificationCodeLength,
        );
        this.dtmfBuffer = "";
        this.attemptGuardianCodeVerification(enteredCode);
      }
      return;
    }

    // If invite redemption is pending, accumulate digits and validate
    // the code against the caller's active voice invite.
    if (
      this.connectionState === "verification_pending" &&
      this.inviteRedemptionActive
    ) {
      this.dtmfBuffer += msg.digit;

      if (this.dtmfBuffer.length >= this.inviteRedemptionCodeLength) {
        const enteredCode = this.dtmfBuffer.slice(
          0,
          this.inviteRedemptionCodeLength,
        );
        this.dtmfBuffer = "";
        this.attemptInviteCodeRedemption(enteredCode);
      }
      return;
    }

    // If outbound callee verification is pending, accumulate digits and check the code
    if (
      this.connectionState === "verification_pending" &&
      this.verificationCode
    ) {
      this.dtmfBuffer += msg.digit;

      if (this.dtmfBuffer.length >= this.verificationCodeLength) {
        const enteredCode = this.dtmfBuffer.slice(
          0,
          this.verificationCodeLength,
        );
        this.dtmfBuffer = "";

        if (enteredCode === this.verificationCode) {
          // Verification succeeded
          this.connectionState = "connected";
          this.verificationCode = null;
          this.verificationAttempts = 0;

          recordCallEvent(
            this.callSessionId,
            "callee_verification_succeeded",
            {},
          );
          log.info(
            { callSessionId: this.callSessionId },
            "Callee verification succeeded",
          );

          // Proceed to the normal call flow
          if (this.controller) {
            this.controller
              .startInitialGreeting()
              .catch((err) =>
                log.error(
                  { err, callSessionId: this.callSessionId },
                  "Failed to start initial outbound greeting after verification",
                ),
              );
          }
        } else {
          // Verification failed for this attempt
          this.verificationAttempts++;

          if (this.verificationAttempts >= this.verificationMaxAttempts) {
            // Max attempts reached — end the call
            recordCallEvent(this.callSessionId, "callee_verification_failed", {
              attempts: this.verificationAttempts,
            });
            log.warn(
              {
                callSessionId: this.callSessionId,
                attempts: this.verificationAttempts,
              },
              "Callee verification failed — max attempts reached",
            );

            this.sendTextToken("Verification failed. Goodbye.", true);

            // Mark failed immediately so a relay close during the goodbye TTS
            // window cannot race this into a terminal "completed" status.
            updateCallSession(this.callSessionId, {
              status: "failed",
              endedAt: Date.now(),
              lastError: "Callee verification failed — max attempts exceeded",
            });

            const session = getCallSession(this.callSessionId);
            if (session) {
              finalizeCall(this.callSessionId, session.conversationId);
              if (session.initiatedFromConversationId) {
                addPointerMessage(
                  session.initiatedFromConversationId,
                  "failed",
                  session.toNumber,
                  {
                    reason: "Callee verification failed",
                  },
                ).catch((err) => {
                  log.warn(
                    {
                      conversationId: session.initiatedFromConversationId,
                      err,
                    },
                    "Skipping pointer write — origin conversation may no longer exist",
                  );
                });
              }
            }

            // End the call with failed status after TTS plays
            setTimeout(() => {
              this.endSession("Verification failed");
            }, getTtsPlaybackDelayMs());
          } else {
            // Allow another attempt
            log.info(
              {
                callSessionId: this.callSessionId,
                attempt: this.verificationAttempts,
                maxAttempts: this.verificationMaxAttempts,
              },
              "Callee verification attempt failed — retrying",
            );
            this.sendTextToken(
              "That code was incorrect. Please try again.",
              true,
            );
          }
        }
      }
    }
  }

  private handleError(msg: RelayErrorMessage): void {
    log.error(
      { callSessionId: this.callSessionId, description: msg.description },
      "ConversationRelay error",
    );

    recordCallEvent(this.callSessionId, "call_failed", {
      error: msg.description,
    });
  }
}
