/**
 * Session-source and controller-profile abstractions for CallController.
 *
 * CallController reads session state (conversation binding at construction,
 * lifecycle fields during the call) through a VoiceSessionSource, and routes
 * behavior that differs between phone calls and in-app live-voice sessions
 * through a VoiceControllerProfile. Phone calls use the store-backed
 * implementations below; in-app voice sessions have no call_sessions row at
 * all, so their profile turns every store write into a no-op and lets the
 * live-voice session own teardown, approvals, and TTS synthesis.
 */

import type { ChannelId, InterfaceId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import {
  getEndCallListenWindowMs,
  getMaxCallDurationMs,
  getSilenceTimeoutMs,
  getUserConsultationTimeoutMs,
} from "./call-constants.js";
import {
  formatDuration,
  postPointerMessageSafe,
} from "./call-pointer-messages.js";
import {
  createPendingQuestion,
  expirePendingQuestions,
  getCallSession,
  recordCallEvent,
  updateCallSession,
} from "./call-store.js";
import { finalizeCall } from "./finalize-call.js";
import type {
  CallEventType,
  CallPendingQuestion,
  CallStatus,
} from "./types.js";
import { buildLiveVoiceControlPrompt } from "./voice-session-bridge.js";

/** Point-in-time view of the session lifecycle fields CallController reads. */
export interface VoiceSessionSnapshot {
  status: CallStatus;
  conversationId: string;
  initiatedFromConversationId: string | null;
  startedAt: number | null;
  toNumber: string;
}

export interface VoiceSessionSource {
  /** Conversation the voice session is bound to. */
  readonly conversationId: string;
  /** When true, the disclosure announcement is skipped for this call. */
  readonly skipDisclosure: boolean;
  /**
   * Current session lifecycle state, re-read on each call. Returns null when
   * the underlying session no longer exists (e.g. the row was deleted).
   */
  getSnapshot(): VoiceSessionSnapshot | null;
}

/** Store-backed source for phone calls: wraps getCallSession(callSessionId). */
export function createPhoneVoiceSessionSource(
  callSessionId: string,
): VoiceSessionSource {
  const session = getCallSession(callSessionId);
  return {
    conversationId: session?.conversationId ?? callSessionId,
    skipDisclosure: session?.skipDisclosure ?? false,
    getSnapshot(): VoiceSessionSnapshot | null {
      const current = getCallSession(callSessionId);
      if (!current) {
        return null;
      }
      return {
        status: current.status,
        conversationId: current.conversationId,
        initiatedFromConversationId:
          current.initiatedFromConversationId ?? null,
        startedAt: current.startedAt,
        toNumber: current.toNumber,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Controller profile
// ---------------------------------------------------------------------------

/** Per-turn context CallController merges into each startVoiceTurn call. */
export interface VoiceTurnProfileContext {
  approvalMode: "phone-call" | "local-live-voice";
  userMessageChannel: ChannelId;
  assistantMessageChannel: ChannelId;
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
  /** Per-turn control prompt. Undefined builds the phone prompt; null disables it. */
  voiceControlPrompt: string | null | undefined;
}

/**
 * Guardian consultation surface for the phone flow: the controller persists
 * a pending question and dispatches the consultation cross-channel.
 */
export interface PhoneDispatchGuardianConsultation {
  mode: "phone-dispatch";
  createPendingQuestion(questionText: string): CallPendingQuestion;
  expirePendingQuestions(): void;
}

/**
 * Guardian consultation is disabled: an ASK_GUARDIAN marker in model output
 * is stripped and logged instead of dispatched (approvals surface
 * interactively through the client under local-live-voice).
 */
export interface DisabledGuardianConsultation {
  mode: "disabled";
}

export type GuardianConsultationProfile =
  | PhoneDispatchGuardianConsultation
  | DisabledGuardianConsultation;

/** Timer budgets, read lazily each time the controller arms a timer. */
export interface VoiceControllerTimers {
  maxDurationMs(): number;
  silenceTimeoutMs(): number;
  endCallListenWindowMs(): number;
  consultTimeoutMs(): number;
}

/**
 * Behavioral knobs for CallController that differ between phone calls and
 * in-app live-voice sessions. The phone profile delegates to the call
 * store / finalization modules; the in-app profile turns lifecycle writes
 * into no-ops because no call_sessions row exists for those sessions.
 */
export interface VoiceControllerProfile {
  /** Record a call lifecycle event. Phone: call_events row; in-app: no-op. */
  recordEvent(type: CallEventType, payload?: Record<string, unknown>): void;
  /** Update session lifecycle fields. Phone: call_sessions row; in-app: no-op. */
  updateStatus(updates: { status: CallStatus; endedAt?: number }): void;
  /**
   * Post-completion side effects. Phone: voice-conversation completion
   * (when notifyCompletion) plus a pointer message in the initiating
   * conversation; in-app: no-op (transport endSession closes the session).
   */
  finalize(
    session: VoiceSessionSnapshot,
    opts: { notifyCompletion: boolean },
  ): void;
  guardianConsultation: GuardianConsultationProfile;
  /** Turn context merged into the controller's startVoiceTurn calls. */
  voiceTurn: VoiceTurnProfileContext;
  timers: VoiceControllerTimers;
  /**
   * "auto": resolve the call TTS provider per turn (synthesized-play vs
   * native token streaming). "token-stream": always stream tokens through
   * the transport — the transport owns synthesis and sendPlayUrl is never
   * used.
   */
  speechOutput: "auto" | "token-stream";
}

/** Store-backed profile for phone calls. */
export function createPhoneVoiceControllerProfile(
  callSessionId: string,
): VoiceControllerProfile {
  return {
    recordEvent(type, payload) {
      recordCallEvent(callSessionId, type, payload);
    },
    updateStatus(updates) {
      updateCallSession(callSessionId, updates);
    },
    finalize(session, opts) {
      if (opts.notifyCompletion) {
        finalizeCall(callSessionId, session.conversationId);
      }
      if (session.initiatedFromConversationId) {
        const durationMs = session.startedAt
          ? Date.now() - session.startedAt
          : 0;
        postPointerMessageSafe(
          session.initiatedFromConversationId,
          "completed",
          session.toNumber,
          {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          },
        );
      }
    },
    guardianConsultation: {
      mode: "phone-dispatch",
      createPendingQuestion: (questionText) =>
        createPendingQuestion(callSessionId, questionText),
      expirePendingQuestions: () => expirePendingQuestions(callSessionId),
    },
    voiceTurn: {
      approvalMode: "phone-call",
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
      userMessageInterface: "phone",
      assistantMessageInterface: "phone",
      voiceControlPrompt: undefined,
    },
    timers: {
      maxDurationMs: getMaxCallDurationMs,
      silenceTimeoutMs: getSilenceTimeoutMs,
      endCallListenWindowMs: getEndCallListenWindowMs,
      consultTimeoutMs: getUserConsultationTimeoutMs,
    },
    speechOutput: "auto",
  };
}

/**
 * Profile for in-app live-voice sessions. No call_sessions row exists, so
 * lifecycle writes are no-ops; teardown is owned by the live-voice session
 * (via transport endSession); guardian consultation is disabled because
 * approvals surface interactively through the client; and the transport
 * owns TTS synthesis (token-stream).
 */
export function createInAppVoiceControllerProfile(): VoiceControllerProfile {
  return {
    recordEvent() {},
    updateStatus() {},
    finalize() {},
    guardianConsultation: { mode: "disabled" },
    voiceTurn: {
      approvalMode: "local-live-voice",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      voiceControlPrompt: buildLiveVoiceControlPrompt(),
    },
    timers: {
      maxDurationMs: () =>
        getConfig().liveVoice.maxSessionDurationSeconds * 1000,
      silenceTimeoutMs: getSilenceTimeoutMs,
      // In-app END_CALL ends the session immediately — no telephony
      // "wait, one more thing" listen window.
      endCallListenWindowMs: () => 0,
      // Unreachable while guardian consultation is disabled.
      consultTimeoutMs: getUserConsultationTimeoutMs,
    },
    speechOutput: "token-stream",
  };
}
