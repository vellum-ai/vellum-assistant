/**
 * WebSocket handler for Twilio ConversationRelay protocol.
 *
 * Manages real-time voice conversations over WebSocket. Each active call
 * has a single RelayConnection instance that processes inbound messages
 * from Twilio and can send text tokens back for TTS.
 */

import { randomInt } from "node:crypto";

import type { ServerWebSocket } from "bun";

import {
  findGuardianForChannel,
  listGuardianChannels,
} from "../contacts/contact-store.js";
import {
  touchContactInteraction,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import { addMessage } from "../memory/conversation-crud.js";
import { revokeScopedApprovalGrantsForContext } from "../memory/scoped-approval-grants.js";
import { resolveGuardianName } from "../prompts/user-reference.js";
import { notifyGuardianOfAccessRequest } from "../runtime/access-request-helper.js";
import {
  resolveActorTrust,
  toTrustContext,
} from "../runtime/actor-trust-resolver.js";
import {
  composeVerificationVoice,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/verification-templates.js";
import { parseJsonSafe } from "../util/json.js";
import { getLogger } from "../util/logger.js";
import {
  getAccessRequestPollIntervalMs,
  getTtsPlaybackDelayMs,
  getUserConsultationTimeoutMs,
} from "./call-constants.js";
import { CallController } from "./call-controller.js";
import { addPointerMessage, formatDuration } from "./call-pointer-messages.js";
import { speakSystemPrompt } from "./call-speech-output.js";
import { fireCallTranscriptNotifier } from "./call-state.js";
import { isTerminalState } from "./call-state-machine.js";
import {
  getCallSession,
  recordCallEvent,
  updateCallSession,
} from "./call-store.js";
import { ConversationRelayTransport } from "./call-transport.js";
import { finalizeCall } from "./finalize-call.js";
import {
  classifyWaitUtterance,
  emitAccessRequestCallbackHandoff,
  scheduleNextHeartbeat,
} from "./relay-access-wait.js";
import { routeSetup, type SetupResolved } from "./relay-setup-router.js";
import {
  attemptInviteCodeRedemption,
  attemptVerificationCode,
  parseDigitsFromSpeech,
} from "./relay-verification.js";
import {
  extractPromptSpeakerMetadata,
  type PromptSpeakerContext,
  SpeakerIdentityTracker,
} from "./speaker-identification.js";

const log = getLogger("relay-server");

// ── ConversationRelay message types ──────────────────────────────────

// Messages FROM Twilio
interface RelaySetupMessage {
  type: "setup";
  callSid: string;
  from: string;
  to: string;
  customParameters?: Record<string, string>;
}

interface RelayPromptMessage {
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

interface RelayInterruptMessage {
  type: "interrupt";
  utteranceUntilInterrupt: string;
}

interface RelayDtmfMessage {
  type: "dtmf";
  digit: string;
}

interface RelayErrorMessage {
  type: "error";
  description: string;
}

type RelayInboundMessage =
  | RelaySetupMessage
  | RelayPromptMessage
  | RelayInterruptMessage
  | RelayDtmfMessage
  | RelayErrorMessage;

// Messages TO Twilio
interface RelayTextMessage {
  type: "text";
  token: string;
  last: boolean;
}

interface RelayEndMessage {
  type: "end";
  handoffData?: string;
}

interface RelayPlayMessage {
  type: "play";
  source: string;
  interruptible: boolean;
}

// ── WebSocket data type ──────────────────────────────────────────────

export interface RelayWebSocketData {
  callSessionId: string;
}

// ── Module-level state ───────────────────────────────────────────────

/** Active relay connections keyed by callSessionId. */
export const activeRelayConnections = new Map<string, RelayConnection>();

/** Module-level broadcast function, set by the HTTP server during startup. */
let globalBroadcast: ((msg: ServerMessage) => void) | undefined;

/** Register a broadcast function so RelayConnection can forward events to connected clients. */
export function setRelayBroadcast(fn: (msg: ServerMessage) => void): void {
  globalBroadcast = fn;
}

// ── RelayConnection ──────────────────────────────────────────────────

/**
 * Manages a single WebSocket connection for one call.
 */
type RelayConnectionState =
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
  private verificationSessionActive = false;
  private verificationAssistantId: string | null = null;
  private verificationFromNumber: string | null = null;

  // Outbound guardian verification state (system calls the guardian)
  private outboundVerificationSessionId: string | null = null;

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
  isVerificationSessionActive(): boolean {
    return this.verificationSessionActive;
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
   * Send a play-audio URL to the caller. Used when the assistant handles
   * TTS synthesis itself (e.g. Fish Audio) instead of relying on
   * ConversationRelay's built-in TTS.
   */
  sendPlayUrl(url: string): void {
    const message: RelayPlayMessage = {
      type: "play",
      source: url,
      interruptible: true,
    };
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Failed to send play URL",
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

    const session = getCallSession(this.callSessionId);
    this.recordSetupBookkeeping(session, msg);

    const { outcome, resolved } = routeSetup({
      callSessionId: this.callSessionId,
      session,
      from: msg.from,
      to: msg.to,
      customParameters: msg.customParameters,
    });

    const initialTrustContext = toTrustContext(
      resolved.actorTrust,
      resolved.otherPartyNumber,
    );
    const transport = new ConversationRelayTransport(this);
    const controller = new CallController(
      this.callSessionId,
      transport,
      session?.task ?? null,
      {
        broadcast: globalBroadcast,
        assistantId: resolved.assistantId,
        trustContext: initialTrustContext,
      },
    );
    this.setController(controller);

    switch (outcome.action) {
      case "outbound_verification":
        this.startOutboundVerification(
          outcome.assistantId,
          outcome.sessionId,
          outcome.toNumber,
        );
        return;
      case "callee_verification":
        await this.startVerification(session, outcome.verificationConfig);
        return;
      case "deny":
        await this.denyInboundCall(msg.from, resolved, outcome);
        return;
      case "invite_redemption":
        this.startInviteRedemption(
          outcome.assistantId,
          outcome.fromNumber,
          outcome.friendName,
          outcome.guardianName,
          !resolved.isInbound,
        );
        return;
      case "name_capture":
        recordCallEvent(
          this.callSessionId,
          "inbound_acl_name_capture_started",
          {
            from: msg.from,
            trustClass: resolved.actorTrust.trustClass,
          },
        );
        this.startNameCapture(outcome.assistantId, outcome.fromNumber);
        return;
      case "verification":
        if (
          resolved.actorTrust.memberRecord &&
          (resolved.actorTrust.trustClass === "guardian" ||
            resolved.actorTrust.trustClass === "trusted_contact")
        ) {
          touchContactInteraction(resolved.actorTrust.memberRecord.channel.id);
        }
        if (this.controller && resolved.actorTrust.trustClass !== "unknown") {
          this.controller.setTrustContext(
            toTrustContext(resolved.actorTrust, msg.from),
          );
        }
        this.startInboundVerification(outcome.assistantId, outcome.fromNumber);
        return;
      case "normal_call":
        if (outcome.isInbound) {
          if (
            resolved.actorTrust.memberRecord &&
            (resolved.actorTrust.trustClass === "guardian" ||
              resolved.actorTrust.trustClass === "trusted_contact")
          ) {
            touchContactInteraction(
              resolved.actorTrust.memberRecord.channel.id,
            );
          }
          if (this.controller && resolved.actorTrust.trustClass !== "unknown") {
            this.controller.setTrustContext(
              toTrustContext(resolved.actorTrust, msg.from),
            );
          }
        }
        this.startNormalCallFlow(controller, outcome.isInbound);
        return;
    }
  }

  /** Bookkeeping side-effects that run on every setup regardless of routing outcome. */
  private recordSetupBookkeeping(
    session: ReturnType<typeof getCallSession>,
    msg: RelaySetupMessage,
  ): void {
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
        if (!session.startedAt) updates.startedAt = Date.now();
      }
      updateCallSession(this.callSessionId, updates);
    }

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
  }

  /** Deny an inbound call with a TTS message and schedule disconnect. */
  private async denyInboundCall(
    from: string,
    resolved: SetupResolved,
    outcome: { message: string; logReason: string },
  ): Promise<void> {
    recordCallEvent(this.callSessionId, "inbound_acl_denied", {
      from,
      trustClass: resolved.actorTrust.trustClass,
      channelId: resolved.actorTrust.memberRecord?.channel.id,
      memberPolicy: resolved.actorTrust.memberRecord?.channel.policy,
    });
    this.connectionState = "disconnecting";
    updateCallSession(this.callSessionId, {
      status: "failed",
      endedAt: Date.now(),
      lastError: outcome.logReason,
    });
    await speakSystemPrompt(this, outcome.message);
    setTimeout(() => {
      this.endSession(outcome.logReason);
    }, getTtsPlaybackDelayMs());
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
    void speakSystemPrompt(
      this,
      `Please enter the verification code: ${spokenCode}.`,
    );

    // Post the verification code to the initiating conversation so the
    // guardian (user) can share it with the callee.
    if (session?.initiatedFromConversationId) {
      const codeMsg = `\u{1F510} Verification code for call to ${session.toNumber}: ${code}`;
      await addMessage(
        session.initiatedFromConversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: codeMsg }]),
        {
          userMessageChannel: "phone",
          assistantMessageChannel: "phone",
          userMessageInterface: "phone",
          assistantMessageInterface: "phone",
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
   * Start normal call flow — fire the controller greeting.
   */
  private startNormalCallFlow(
    controller: CallController,
    isInbound: boolean,
  ): void {
    controller
      .startInitialGreeting()
      .catch((err) =>
        log.error(
          { err, callSessionId: this.callSessionId },
          `Failed to start initial ${isInbound ? "inbound" : "outbound"} greeting`,
        ),
      );
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
    activationReason?:
      | "invite_redeemed"
      | "access_approved"
      | "trusted_contact_verified";
    friendName?: string;
    guardianName?: string;
  }): void {
    const { assistantId, fromNumber, callerName } = params;

    if (!params.skipMemberActivation) {
      try {
        upsertContactChannel({
          sourceChannel: "phone",
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
      sourceChannel: "phone",
      conversationExternalId: fromNumber,
      actorExternalId: fromNumber,
    });

    if (this.controller) {
      this.controller.setTrustContext(toTrustContext(updatedTrust, fromNumber));
    }

    this.connectionState = "connected";
    updateCallSession(this.callSessionId, { status: "in_progress" });

    const guardianLabel = this.resolveGuardianLabel();
    let handoffText: string;

    if (params.activationReason === "invite_redeemed") {
      const name = params.friendName;
      const assistantName = this.resolveAssistantLabel();
      const gLabel = params.guardianName || guardianLabel;
      if (name) {
        handoffText = assistantName
          ? `Great, I've verified that you are ${name}. It's nice to meet you! I'm ${assistantName}, ${gLabel}'s assistant. How can I help?`
          : `Great, I've verified that you are ${name}. It's nice to meet you! How can I help?`;
      } else {
        handoffText = assistantName
          ? `Great, I've verified your identity. It's nice to meet you! I'm ${assistantName}, ${gLabel}'s assistant. How can I help?`
          : `Great, I've verified your identity. It's nice to meet you! How can I help?`;
      }
    } else {
      handoffText = `Great! ${guardianLabel} said I can speak with you. How can I help?`;
    }

    void speakSystemPrompt(this, handoffText);

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
  private startInboundVerification(
    assistantId: string,
    fromNumber: string,
  ): void {
    this.verificationSessionActive = true;
    this.verificationAssistantId = assistantId;
    this.verificationFromNumber = fromNumber;
    this.connectionState = "verification_pending";
    this.verificationAttempts = 0;
    this.verificationMaxAttempts = 3;
    this.verificationCodeLength = 6;
    this.dtmfBuffer = "";

    recordCallEvent(this.callSessionId, "voice_verification_started", {
      assistantId,
      maxAttempts: this.verificationMaxAttempts,
    });

    void speakSystemPrompt(
      this,
      "Welcome. Please enter your six-digit verification code using your keypad, or speak the digits now.",
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
  private startOutboundVerification(
    assistantId: string,
    verificationSessionId: string,
    toNumber: string,
  ): void {
    this.verificationSessionActive = true;
    this.outboundVerificationSessionId = verificationSessionId;
    this.verificationAssistantId = assistantId;
    // For outbound guardian calls, the "to" number is the guardian's phone
    this.verificationFromNumber = toNumber;
    this.connectionState = "verification_pending";
    this.verificationAttempts = 0;
    this.verificationMaxAttempts = 3;
    this.verificationCodeLength = 6;
    this.dtmfBuffer = "";

    recordCallEvent(this.callSessionId, "outbound_voice_verification_started", {
      assistantId,
      verificationSessionId,
      maxAttempts: this.verificationMaxAttempts,
    });

    const introText = composeVerificationVoice(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_CALL_INTRO,
      { codeDigits: this.verificationCodeLength },
    );
    void speakSystemPrompt(this, introText);

    log.info(
      {
        callSessionId: this.callSessionId,
        assistantId,
        verificationSessionId,
      },
      "Outbound guardian voice verification started",
    );
  }

  /**
   * Validate an entered code against the pending voice guardian challenge.
   * Delegates to the extracted attemptVerificationCode() and
   * interprets the structured result to drive side-effects.
   */
  private async handleVerificationCodeResult(
    enteredCode: string,
  ): Promise<void> {
    if (!this.verificationAssistantId || !this.verificationFromNumber) {
      return;
    }

    const isOutbound = this.outboundVerificationSessionId != null;
    const assistantId = this.verificationAssistantId;
    const fromNumber = this.verificationFromNumber;

    const result = attemptVerificationCode({
      verificationAssistantId: assistantId,
      verificationFromNumber: fromNumber,
      enteredCode,
      isOutbound,
      codeDigits: this.verificationCodeLength,
      verificationAttempts: this.verificationAttempts,
      verificationMaxAttempts: this.verificationMaxAttempts,
    });

    if (result.outcome === "success") {
      this.connectionState = "connected";
      this.verificationSessionActive = false;
      this.verificationAttempts = 0;
      this.dtmfBuffer = "";

      recordCallEvent(this.callSessionId, result.eventName, {
        verificationType: result.verificationType,
      });
      log.info(
        { callSessionId: this.callSessionId, isOutbound },
        "Guardian voice verification succeeded",
      );

      if (isOutbound) {
        // Keep the pointer message back to the initiating conversation
        const successSession = getCallSession(this.callSessionId);
        if (successSession?.initiatedFromConversationId) {
          addPointerMessage(
            successSession.initiatedFromConversationId,
            "verification_succeeded",
            successSession.toNumber,
            { channel: "phone" },
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

        // Update trust context on the controller so the LLM knows this is the guardian
        if (this.controller) {
          const verifiedActorTrust = resolveActorTrust({
            assistantId,
            sourceChannel: "phone",
            conversationExternalId: fromNumber,
            actorExternalId: fromNumber,
          });
          this.controller.setTrustContext(
            toTrustContext(verifiedActorTrust, fromNumber),
          );
        }

        // Mark session as in-progress and transition to guardian conversation
        // with verification context so the LLM greets naturally.
        updateCallSession(this.callSessionId, { status: "in_progress" });
        if (this.controller) {
          this.controller
            .startPostVerificationGreeting()
            .catch((err) =>
              log.error(
                { err, callSessionId: this.callSessionId },
                "Failed to start post-verification greeting",
              ),
            );
        }
      } else if (result.verificationType === "trusted_contact") {
        this.continueCallAfterTrustedContactActivation({
          assistantId,
          fromNumber,
          activationReason: "trusted_contact_verified",
        });
      } else {
        // Inbound guardian verification: binding already handled above,
        // proceed to normal call flow.
        if (this.controller) {
          const verifiedActorTrust = resolveActorTrust({
            assistantId,
            sourceChannel: "phone",
            conversationExternalId: fromNumber,
            actorExternalId: fromNumber,
          });
          this.controller.setTrustContext(
            toTrustContext(verifiedActorTrust, fromNumber),
          );
          this.startNormalCallFlow(this.controller, true);
        }
      }
    } else if (result.outcome === "failure") {
      this.verificationSessionActive = false;
      this.verificationAttempts = result.attempts;

      recordCallEvent(this.callSessionId, result.eventName, {
        attempts: result.attempts,
      });
      log.warn(
        {
          callSessionId: this.callSessionId,
          attempts: result.attempts,
          isOutbound,
        },
        "Guardian voice verification failed — max attempts reached",
      );

      updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: "Guardian voice verification failed — max attempts exceeded",
      });

      const failSession = getCallSession(this.callSessionId);
      if (failSession) {
        finalizeCall(this.callSessionId, failSession.conversationId);

        if (isOutbound && failSession.initiatedFromConversationId) {
          addPointerMessage(
            failSession.initiatedFromConversationId,
            "verification_failed",
            failSession.toNumber,
            {
              channel: "phone",
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

      await speakSystemPrompt(this, result.ttsMessage);
      setTimeout(() => {
        this.endSession("Verification failed — challenge rejected");
      }, getTtsPlaybackDelayMs());
    } else {
      // retry
      this.verificationAttempts = result.attempt;

      log.info(
        {
          callSessionId: this.callSessionId,
          attempt: result.attempt,
          maxAttempts: result.maxAttempts,
          isOutbound,
        },
        "Guardian voice verification attempt failed — retrying",
      );
      void speakSystemPrompt(this, result.ttsMessage);
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
    isOutbound: boolean,
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

    let promptText: string;
    if (isOutbound) {
      const assistantName = this.resolveAssistantLabel();
      promptText = assistantName
        ? `Hi ${displayFriend}, this is ${assistantName}, ${displayGuardian}'s assistant. To get started, please enter the 6-digit code that ${displayGuardian} shared with you.`
        : `Hi ${displayFriend}, this is ${displayGuardian}'s assistant. To get started, please enter the 6-digit code that ${displayGuardian} shared with you.`;
    } else {
      promptText = `Welcome ${displayFriend}. Please enter the 6-digit code that ${displayGuardian} provided you to verify your identity.`;
    }
    void speakSystemPrompt(this, promptText);

    log.info(
      { callSessionId: this.callSessionId, assistantId },
      `${isOutbound ? "Outbound" : "Inbound"} voice invite redemption started`,
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

    void speakSystemPrompt(this, greeting);

    // Start a timeout so silent callers don't keep the call open indefinitely.
    // Uses a 30-second window — enough time to speak a name but short enough
    // to avoid wasting resources on callers who never respond.
    const NAME_CAPTURE_TIMEOUT_MS = 30_000;
    this.nameCaptureTimeoutTimer = setTimeout(() => {
      if (this.connectionState !== "awaiting_name") return;
      void this.handleNameCaptureTimeout();
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
        sourceChannel: "phone",
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
      void this.handleAccessRequestTimeout();
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
    void speakSystemPrompt(
      this,
      `Thank you. I've let ${guardianLabel} know. Please hold while I check if I have permission to speak with you.`,
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
        void this.handleAccessRequestDenied();
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

      void this.handleAccessRequestTimeout();
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
      activationReason: "access_approved",
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
  private async handleAccessRequestDenied(): Promise<void> {
    this.clearAccessRequestWait();

    const guardianLabel = this.resolveGuardianLabel();

    recordCallEvent(this.callSessionId, "inbound_acl_access_denied", {
      from: this.accessRequestFromNumber,
      requestId: this.accessRequestId,
    });

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

    await speakSystemPrompt(
      this,
      `Sorry, ${guardianLabel} says I'm not allowed to speak with you. Goodbye.`,
    );
    setTimeout(() => {
      this.endSession("Access request denied");
    }, getTtsPlaybackDelayMs());
  }

  /**
   * Handle an access request timeout: deliver deterministic copy and hang up.
   */
  private async handleAccessRequestTimeout(): Promise<void> {
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

    await speakSystemPrompt(
      this,
      `Sorry, I can't get ahold of ${guardianLabel} right now. I'll let them know you called.${callbackNote}`,
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
  private async handleNameCaptureTimeout(): Promise<void> {
    if (this.nameCaptureTimeoutTimer) {
      clearTimeout(this.nameCaptureTimeoutTimer);
      this.nameCaptureTimeoutTimer = null;
    }

    recordCallEvent(this.callSessionId, "inbound_acl_name_capture_timeout", {
      from: this.accessRequestFromNumber,
    });

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

    await speakSystemPrompt(
      this,
      "Sorry, I didn't catch your name. Please try calling back. Goodbye.",
    );
    setTimeout(() => {
      this.endSession("Name capture timed out");
    }, getTtsPlaybackDelayMs());
  }

  /**
   * Validate an entered invite code against active voice invites.
   * Delegates to the extracted attemptInviteCodeRedemption() and
   * interprets the structured result to drive side-effects.
   */
  private async handleInviteCodeRedemptionResult(
    enteredCode: string,
  ): Promise<void> {
    if (!this.inviteRedemptionAssistantId || !this.inviteRedemptionFromNumber) {
      return;
    }

    const result = attemptInviteCodeRedemption({
      inviteRedemptionAssistantId: this.inviteRedemptionAssistantId,
      inviteRedemptionFromNumber: this.inviteRedemptionFromNumber,
      enteredCode,
      inviteRedemptionGuardianName: this.inviteRedemptionGuardianName,
    });

    if (result.outcome === "success") {
      this.inviteRedemptionActive = false;
      this.verificationAttempts = 0;
      this.dtmfBuffer = "";

      recordCallEvent(this.callSessionId, "invite_redemption_succeeded", {
        memberId: result.memberId,
        ...(result.inviteId ? { inviteId: result.inviteId } : {}),
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
        activationReason: "invite_redeemed",
        friendName: this.inviteRedemptionFriendName ?? undefined,
        guardianName: this.inviteRedemptionGuardianName ?? undefined,
      });
    } else {
      this.inviteRedemptionActive = false;

      recordCallEvent(this.callSessionId, "invite_redemption_failed", {
        attempts: 1,
      });
      log.warn(
        { callSessionId: this.callSessionId },
        "Voice invite redemption failed — invalid or expired code",
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

      await speakSystemPrompt(this, result.ttsMessage);
      setTimeout(() => {
        this.endSession("Invite redemption failed");
      }, getTtsPlaybackDelayMs());
    }
  }

  // ── Guardian wait UX layer ─────────────────────────────────────

  /**
   * Resolve a human-readable guardian label for voice wait copy.
   * Delegates to the shared resolveGuardianName() which checks the
   * guardian's per-user persona file (users/<slug>.md) first, then falls
   * back to Contact.displayName, then DEFAULT_USER_REFERENCE.
   */
  private resolveGuardianLabel(): string {
    // Look up the guardian contact for a displayName fallback
    const voiceGuardian = findGuardianForChannel("phone");
    const guardianChannels = voiceGuardian ? null : listGuardianChannels();
    const guardianContact = voiceGuardian?.contact ?? guardianChannels?.contact;

    return resolveGuardianName(guardianContact?.displayName);
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

  private scheduleNextHeartbeat(): void {
    this.accessRequestHeartbeatTimer = scheduleNextHeartbeat({
      isWaitActive: () => this.accessRequestWaitActive,
      accessRequestWaitStartedAt: this.accessRequestWaitStartedAt,
      callSessionId: this.callSessionId,
      consumeSequence: () => this.heartbeatSequence++,
      resolveGuardianLabel: () => this.resolveGuardianLabel(),
      sendTextToken: (text, _last) => void speakSystemPrompt(this, text),
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
        void speakSystemPrompt(
          this,
          `Noted, I'll make sure ${guardianLabel} knows you'd like a callback. For now, I'll keep trying to reach them.`,
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
        void speakSystemPrompt(
          this,
          `No problem, I'll keep holding. Still waiting on ${guardianLabel}.`,
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
          void speakSystemPrompt(
            this,
            `I understand this is taking a while. I can have ${guardianLabel} call you back once I hear from them. Would you like that, or would you prefer to keep holding?`,
          );
        } else {
          // Already offered callback — just reassure
          void speakSystemPrompt(
            this,
            `I hear you, I'm sorry for the wait. Still trying to reach ${guardianLabel}.`,
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
        void speakSystemPrompt(
          this,
          `Yes, I'm still here. Still waiting to hear back from ${guardianLabel}.`,
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
        void speakSystemPrompt(
          this,
          `Thanks for that. I'm still waiting on ${guardianLabel}. I'll let you know as soon as I hear back.`,
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
      this.verificationSessionActive
    ) {
      const spokenDigits = parseDigitsFromSpeech(msg.voicePrompt);
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
        void this.handleVerificationCodeResult(enteredCode);
      } else if (spokenDigits.length > 0) {
        void speakSystemPrompt(
          this,
          `I heard ${spokenDigits.length} digits. Please enter all ${this.verificationCodeLength} digits of your code.`,
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
      const spokenDigits = parseDigitsFromSpeech(msg.voicePrompt);
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
        void this.handleInviteCodeRedemptionResult(enteredCode);
      } else if (spokenDigits.length > 0) {
        void speakSystemPrompt(
          this,
          `I heard ${spokenDigits.length} digits. Please enter all ${this.inviteRedemptionCodeLength} digits of your code.`,
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
      // User message persistence is handled by the conversation pipeline
      // (voice-session-bridge -> conversation.persistUserMessage) so we only
      // need to fire the transcript notifier for UI subscribers here.
      fireCallTranscriptNotifier(
        session.conversationId,
        this.callSessionId,
        "caller",
        msg.voicePrompt,
      );
    }

    // Route to controller for conversation-backed response
    if (this.controller) {
      await this.controller.handleCallerUtterance(msg.voicePrompt, speaker);
    } else {
      // Fallback if controller not yet initialized — persist the caller's
      // transcript so it is available in conversation history once setup
      // completes. The conversation pipeline normally handles persistence, but
      // this early-utterance path bypasses it entirely.
      if (session) {
        try {
          await addMessage(
            session.conversationId,
            "user",
            JSON.stringify([{ type: "text", text: msg.voicePrompt }]),
            {
              userMessageChannel: "phone",
              assistantMessageChannel: "phone",
              userMessageInterface: "phone",
              assistantMessageInterface: "phone",
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
      void speakSystemPrompt(this, "I'm still setting up. Please hold.");
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
      this.verificationSessionActive
    ) {
      this.dtmfBuffer += msg.digit;

      if (this.dtmfBuffer.length >= this.verificationCodeLength) {
        const enteredCode = this.dtmfBuffer.slice(
          0,
          this.verificationCodeLength,
        );
        this.dtmfBuffer = "";
        void this.handleVerificationCodeResult(enteredCode);
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
        void this.handleInviteCodeRedemptionResult(enteredCode);
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

            // Wait for synthesis to complete before starting teardown timer
            // so the caller hears the goodbye message.
            void speakSystemPrompt(this, "Verification failed. Goodbye.")
              .then(() => {
                setTimeout(() => {
                  this.endSession("Verification failed");
                }, getTtsPlaybackDelayMs());
              })
              .catch((err) => {
                log.error(
                  { err, callSessionId: this.callSessionId },
                  "System prompt TTS failed during verification teardown",
                );
                setTimeout(() => {
                  this.endSession("Verification failed");
                }, getTtsPlaybackDelayMs());
              });
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
            void speakSystemPrompt(
              this,
              "That code was incorrect. Please try again.",
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
