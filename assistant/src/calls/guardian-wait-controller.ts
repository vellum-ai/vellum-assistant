/**
 * Transport-agnostic guardian access-request wait controller.
 *
 * Owns the in-call wait for a guardian's decision on a caller access
 * request: the hold message, periodic heartbeat updates, canonical-request
 * polling, the consultation timeout, and wait-state utterance handling
 * (reassurance, impatience, callback offer/opt-in). Resolution is
 * delivered through injected `onApproved` / `onDenied` / `onTimeout`
 * callbacks; the consumer owns the terminal copy and session teardown.
 *
 * The controller is the sole source of truth for its wait state — it is
 * never inferred from the transport. All side effects flow through
 * injected deps so the controller is unit-testable and independent of any
 * wire protocol. Pure wait helpers (`classifyWaitUtterance`,
 * `scheduleNextHeartbeat`, `emitAccessRequestCallbackHandoff`) are reused
 * from relay-access-wait.ts.
 */

import { getCanonicalGuardianRequest as getCanonicalGuardianRequestFn } from "../contacts/canonical-guardian-store.js";
import { getLogger } from "../util/logger.js";
import {
  getAccessRequestPollIntervalMs,
  getTtsPlaybackDelayMs,
  getUserConsultationTimeoutMs,
} from "./call-constants.js";
import type {
  recordCallEvent as recordCallEventFn,
  updateCallSession as updateCallSessionFn,
} from "./call-store.js";
import {
  classifyWaitUtterance,
  emitAccessRequestCallbackHandoff,
  scheduleNextHeartbeat,
} from "./relay-access-wait.js";

const log = getLogger("guardian-wait-controller");

/** Minimum gap between spoken replies to non-callback wait utterances. */
export const IN_WAIT_REPLY_COOLDOWN_MS = 3000;

// ── Public types ─────────────────────────────────────────────────────

export type GuardianWaitState =
  | "idle"
  | "awaiting_guardian_decision"
  | "resolved"
  | "disposed";

export type GuardianWaitResolution = "approved" | "denied" | "timeout";

/**
 * Dispose reason. `transport_closed` additionally emits the callback
 * handoff notification when the caller opted into a callback and the wait
 * was still unresolved.
 */
export type GuardianWaitDisposeReason = "transport_closed" | "teardown";

/** Context passed to every resolution callback. */
export interface GuardianWaitResolutionContext {
  requestId: string;
  assistantId: string;
  fromNumber: string;
  callerName: string | null;
  callbackOptIn: boolean;
}

export interface GuardianWaitStartParams {
  /** Canonical guardian access-request id to poll. */
  requestId: string;
  assistantId: string;
  fromNumber: string;
  callerName: string | null;
}

export interface GuardianWaitControllerDeps {
  /** Speak a deterministic system prompt through the call transport. */
  speakSystemPrompt(text: string): Promise<void>;
  updateCallSession(
    id: string,
    updates: Parameters<typeof updateCallSessionFn>[1],
  ): void;
  recordCallEvent(
    callSessionId: string,
    eventType: Parameters<typeof recordCallEventFn>[1],
    payload?: Record<string, unknown>,
  ): void;
  /** Human-readable guardian label for wait copy. */
  resolveGuardianLabel(): string;
  onApproved(ctx: GuardianWaitResolutionContext): void | Promise<void>;
  onDenied(ctx: GuardianWaitResolutionContext): void | Promise<void>;
  onTimeout(ctx: GuardianWaitResolutionContext): void | Promise<void>;
  /** Canonical-request reader; defaults to the real store. */
  getCanonicalGuardianRequest?: typeof getCanonicalGuardianRequestFn;
  /** Clock; defaults to Date.now. */
  now?: () => number;
  /** Overrides the `calls.accessRequestPollIntervalMs` config value. */
  pollIntervalMs?: number;
  /** Overrides the `calls.userConsultTimeoutSeconds` config value. */
  consultTimeoutMs?: number;
  /**
   * Delay before the first heartbeat so the hold message finishes
   * playing. Overrides the `calls.ttsPlaybackDelayMs` config value.
   */
  firstHeartbeatDelayMs?: number;
  /** Overrides {@link IN_WAIT_REPLY_COOLDOWN_MS}. */
  inWaitReplyCooldownMs?: number;
}

// ── Controller ───────────────────────────────────────────────────────

export class GuardianWaitController {
  private state: GuardianWaitState = "idle";
  private resolution: GuardianWaitResolution | null = null;
  private params: GuardianWaitStartParams | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  private waitStartedAt = 0;
  private heartbeatSequence = 0;
  private lastInWaitReplyAt = 0;

  private callbackOfferMade = false;
  private callbackOptIn = false;
  private callbackHandoffNotified = false;

  constructor(
    private readonly callSessionId: string,
    private readonly deps: GuardianWaitControllerDeps,
  ) {}

  /** Explicit controller state — never inferred from the transport. */
  getState(): GuardianWaitState {
    return this.state;
  }

  /** Resolution reached, or null while unresolved. */
  getResolution(): GuardianWaitResolution | null {
    return this.resolution;
  }

  /**
   * Begin the wait: speak the hold message, mark the session
   * `waiting_on_user`, and arm the heartbeat, poll, and timeout timers.
   * May only be called once per controller instance.
   */
  start(params: GuardianWaitStartParams): void {
    if (this.state !== "idle") {
      throw new Error("GuardianWaitController.start() may only be called once");
    }
    this.params = params;
    this.state = "awaiting_guardian_decision";

    const guardianLabel = this.deps.resolveGuardianLabel();
    void this.speak(
      `Thank you. I've let ${guardianLabel} know. Please hold while I check if I have permission to speak with you.`,
    );

    this.deps.updateCallSession(this.callSessionId, {
      status: "waiting_on_user",
    });

    // The first heartbeat waits out the hold message's TTS playback. The
    // wait start time is stamped now so heartbeat scheduling has a valid
    // reference point even if this timer is cancelled early (e.g. by a
    // wait-state reply during playback); the callback re-stamps it to
    // exclude the TTS delay.
    this.heartbeatSequence = 0;
    this.waitStartedAt = this.now();
    this.heartbeatTimer = setTimeout(() => {
      this.waitStartedAt = this.now();
      this.scheduleHeartbeat();
    }, this.deps.firstHeartbeatDelayMs ?? getTtsPlaybackDelayMs());

    // The config getters return schema-validated bounded integers
    // (config/schemas/calls.ts), so no runtime finite/NaN guard is needed.
    const pollIntervalMs =
      this.deps.pollIntervalMs ?? getAccessRequestPollIntervalMs();
    this.pollTimer = setInterval(() => {
      this.pollCanonicalRequest();
    }, pollIntervalMs);

    const timeoutMs =
      this.deps.consultTimeoutMs ?? getUserConsultationTimeoutMs();
    this.timeoutTimer = setTimeout(() => {
      if (this.state !== "awaiting_guardian_decision") {
        return;
      }
      log.info(
        { callSessionId: this.callSessionId, requestId: params.requestId },
        "Access request in-call wait timed out",
      );
      this.resolve("timeout");
    }, timeoutMs);

    log.info(
      {
        callSessionId: this.callSessionId,
        requestId: params.requestId,
        timeoutMs,
        pollIntervalMs,
      },
      "Access request in-call wait started",
    );
  }

  /**
   * Handle a caller utterance during the wait: reassurance, impatience
   * detection, and callback offer/opt-in. No-op unless waiting.
   */
  handleTranscript(text: string): void {
    if (this.state !== "awaiting_guardian_decision") {
      return;
    }

    const now = this.now();
    const classification = classifyWaitUtterance(text, this.callbackOfferMade);

    this.deps.recordCallEvent(
      this.callSessionId,
      "voice_guardian_wait_prompt_classified",
      { classification, transcript: text },
    );

    if (classification === "empty") {
      return;
    }

    const guardianLabel = this.deps.resolveGuardianLabel();

    // Callback decisions are always processed regardless of cooldown —
    // the caller is answering a direct question and dropping their
    // response would silently discard their decision.
    switch (classification) {
      case "callback_opt_in": {
        this.callbackOptIn = true;
        this.lastInWaitReplyAt = now;
        this.deps.recordCallEvent(
          this.callSessionId,
          "voice_guardian_wait_callback_opt_in_set",
          {},
        );
        this.resetHeartbeatTimer();
        void this.speak(
          `Noted, I'll make sure ${guardianLabel} knows you'd like a callback. For now, I'll keep trying to reach them.`,
        );
        this.scheduleHeartbeat();
        return;
      }
      case "callback_decline": {
        this.callbackOptIn = false;
        this.lastInWaitReplyAt = now;
        this.deps.recordCallEvent(
          this.callSessionId,
          "voice_guardian_wait_callback_opt_in_declined",
          {},
        );
        this.resetHeartbeatTimer();
        void this.speak(
          `No problem, I'll keep holding. Still waiting on ${guardianLabel}.`,
        );
        this.scheduleHeartbeat();
        return;
      }
      default:
        break;
    }

    // Enforce cooldown on non-callback utterances to prevent spam.
    const cooldownMs =
      this.deps.inWaitReplyCooldownMs ?? IN_WAIT_REPLY_COOLDOWN_MS;
    if (now - this.lastInWaitReplyAt < cooldownMs) {
      log.debug(
        { callSessionId: this.callSessionId },
        "In-wait reply suppressed by cooldown",
      );
      return;
    }
    this.lastInWaitReplyAt = now;

    // Immediate replies reset the heartbeat timer so a scheduled
    // heartbeat doesn't double up with the reassurance.
    this.resetHeartbeatTimer();
    switch (classification) {
      case "impatient": {
        if (!this.callbackOfferMade) {
          this.callbackOfferMade = true;
          this.deps.recordCallEvent(
            this.callSessionId,
            "voice_guardian_wait_callback_offer_sent",
            {},
          );
          void this.speak(
            `I understand this is taking a while. I can have ${guardianLabel} call you back once I hear from them. Would you like that, or would you prefer to keep holding?`,
          );
        } else {
          void this.speak(
            `I hear you, I'm sorry for the wait. Still trying to reach ${guardianLabel}.`,
          );
        }
        break;
      }
      case "patience_check": {
        void this.speak(
          `Yes, I'm still here. Still waiting to hear back from ${guardianLabel}.`,
        );
        break;
      }
      case "neutral":
      default: {
        void this.speak(
          `Thanks for that. I'm still waiting on ${guardianLabel}. I'll let you know as soon as I hear back.`,
        );
        break;
      }
    }
    this.scheduleHeartbeat();
  }

  /**
   * Clear every timer. Idempotent. When `reason` is `transport_closed`
   * and the wait is still unresolved with callback opt-in, emits the
   * callback handoff notification first (at most once per controller).
   */
  dispose(reason: GuardianWaitDisposeReason = "teardown"): void {
    if (
      this.state === "awaiting_guardian_decision" &&
      reason === "transport_closed"
    ) {
      this.emitCallbackHandoff("transport_closed");
    }
    this.clearTimers();
    if (this.state === "idle" || this.state === "awaiting_guardian_decision") {
      this.state = "disposed";
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private pollCanonicalRequest(): void {
    if (this.state !== "awaiting_guardian_decision" || !this.params) {
      this.clearTimers();
      return;
    }
    const read =
      this.deps.getCanonicalGuardianRequest ?? getCanonicalGuardianRequestFn;
    const request = read(this.params.requestId);
    if (!request) {
      return;
    }
    if (request.status === "approved") {
      this.resolve("approved");
    } else if (request.status === "denied") {
      this.resolve("denied");
    }
    // 'pending' continues polling; 'expired'/'cancelled' handled by timeout.
  }

  private resolve(resolution: GuardianWaitResolution): void {
    if (this.state !== "awaiting_guardian_decision" || !this.params) {
      return;
    }
    // Emit the callback handoff before clearing wait state so a caller
    // who opted into a callback gets the guardian notification.
    if (resolution === "timeout") {
      this.emitCallbackHandoff("timeout");
    }
    this.clearTimers();
    this.state = "resolved";
    this.resolution = resolution;

    const ctx: GuardianWaitResolutionContext = {
      requestId: this.params.requestId,
      assistantId: this.params.assistantId,
      fromNumber: this.params.fromNumber,
      callerName: this.params.callerName,
      callbackOptIn: this.callbackOptIn,
    };
    const callback =
      resolution === "approved"
        ? this.deps.onApproved
        : resolution === "denied"
          ? this.deps.onDenied
          : this.deps.onTimeout;
    void Promise.resolve(callback(ctx)).catch((err) => {
      log.error(
        { err, callSessionId: this.callSessionId, resolution },
        "Guardian wait resolution callback failed",
      );
    });
  }

  private emitCallbackHandoff(reason: "timeout" | "transport_closed"): void {
    const result = emitAccessRequestCallbackHandoff({
      reason,
      callbackOptIn: this.callbackOptIn,
      accessRequestId: this.params?.requestId ?? null,
      callbackHandoffNotified: this.callbackHandoffNotified,
      accessRequestAssistantId: this.params?.assistantId ?? null,
      accessRequestFromNumber: this.params?.fromNumber ?? null,
      accessRequestCallerName: this.params?.callerName ?? null,
      callSessionId: this.callSessionId,
    });
    this.callbackHandoffNotified = result.callbackHandoffNotified;
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = scheduleNextHeartbeat({
      isWaitActive: () => this.state === "awaiting_guardian_decision",
      accessRequestWaitStartedAt: this.waitStartedAt,
      callSessionId: this.callSessionId,
      consumeSequence: () => this.heartbeatSequence++,
      resolveGuardianLabel: () => this.deps.resolveGuardianLabel(),
      sendTextToken: (text, _last) => void this.speak(text),
      scheduleNext: () => this.scheduleHeartbeat(),
    });
  }

  private resetHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.resetHeartbeatTimer();
  }

  private speak(text: string): Promise<void> {
    return this.deps.speakSystemPrompt(text).catch((err) => {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Guardian wait speech failed",
      );
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
