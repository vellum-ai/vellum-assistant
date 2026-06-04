/**
 * Transport-agnostic guardian access-request wait controller.
 *
 * When an unknown inbound caller asks to speak with the user, the assistant
 * notifies the user's guardian and then *holds the line* while polling the
 * canonical request for a decision. This controller owns that bounded wait:
 * it speaks the hold message, schedules heartbeat progress updates, polls the
 * canonical request status, enforces a timeout, and handles caller utterances
 * spoken during the wait (patience checks, impatience, callback opt-in/decline).
 *
 * Ported from the stateful wait orchestration that previously lived as private
 * methods on `RelayConnection` (`startAccessRequestWait` and its handlers in
 * `relay-server.ts`). The pure, side-effect-light helpers it depends on already
 * live in {@link ./relay-access-wait.js} — this controller REUSES them rather
 * than duplicating their logic.
 *
 * Design notes:
 * - **Transport-agnostic.** The controller drives any {@link SetupFlowTransport}
 *   (including `MediaStreamOutput`), speaking through an injected
 *   `speakSystemPrompt`.
 * - **Owns its wait state explicitly.** The `awaiting_guardian_decision` state
 *   lives on the controller, NOT on `transport.getConnectionState()`. On the
 *   media-stream transport that method only reports `connected`/`closed`, so it
 *   cannot distinguish "awaiting a guardian decision" from any other phase.
 * - **Injected timing.** Clock, timers, poll/timeout intervals, and the
 *   heartbeat scheduler are all injectable so unit tests run with no real
 *   delays and can drive the timeline deterministically.
 *
 * This file is fresh transport-agnostic code; it does NOT refactor
 * `relay-server.ts` (which is removed later in the migration). PR 8 wires it
 * into `call-setup-flow`.
 */

import type { CanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import { getCanonicalGuardianRequest } from "../memory/canonical-guardian-store.js";
import { getLogger } from "../util/logger.js";
import {
  getAccessRequestPollIntervalMs,
  getTtsPlaybackDelayMs,
  getUserConsultationTimeoutMs,
} from "./call-constants.js";
import type { SetupFlowTransport } from "./call-setup-flow-types.js";
import { recordCallEvent } from "./call-store.js";
import {
  classifyWaitUtterance,
  emitAccessRequestCallbackHandoff,
  scheduleNextHeartbeat,
} from "./relay-access-wait.js";

const log = getLogger("guardian-wait-controller");

// ── State ────────────────────────────────────────────────────────────

/**
 * Explicit wait state, owned by the controller (never transport-derived).
 *
 * - `idle`: no wait in progress (before `start()` / after resolution).
 * - `awaiting_guardian_decision`: actively holding for a guardian decision.
 * - `resolved`: the wait ended (approved / denied / timed out / disposed).
 */
export type GuardianWaitState =
  | "idle"
  | "awaiting_guardian_decision"
  | "resolved";

// ── Parameters ───────────────────────────────────────────────────────

/** Identifying context for the access request being waited on. */
export interface GuardianWaitStartParams {
  /** Canonical access-request id to poll for a decision. */
  accessRequestId: string;
  /** Assistant the call is targeting. */
  assistantId: string;
  /** Caller's phone number (E.164). */
  fromNumber: string;
  /** Caller's spoken name, if captured. */
  callerName: string | null;
}

// ── Dependencies ─────────────────────────────────────────────────────

/**
 * Injected collaborators. Functions/timers are injected (rather than imported
 * directly) so the controller can be unit-tested without a live transport, TTS
 * provider, database, or real timers.
 */
export interface GuardianWaitControllerDeps {
  /** Speak a deterministic prompt through the transport's TTS path. */
  speakSystemPrompt(transport: SetupFlowTransport, text: string): Promise<void>;
  /** Resolve a human-readable label for the guardian (wait copy). */
  resolveGuardianLabel(): string;
  /**
   * Persist the call session's transition to `waiting_on_user` when the wait
   * starts. Mirrors `relay-server.ts`'s
   * `updateCallSession(callSessionId, { status: "waiting_on_user" })` so
   * recovery/UI paths that key off the persisted status observe that the call
   * is blocked on the user. Injected (rather than calling the store directly)
   * to keep the controller transport-agnostic and unit-testable.
   */
  markWaitingOnUser(): void;
  /**
   * Continue the call once the guardian approves. The controller has already
   * cleared its timers when this fires.
   */
  onApproved(params: {
    assistantId: string;
    fromNumber: string;
    callerName: string | null;
  }): void;
  /** The guardian denied the request. The controller has cleared its timers. */
  onDenied(params: { guardianLabel: string }): void;
  /**
   * The wait timed out (or failed closed). Fires after the callback-handoff
   * notification is emitted and timers are cleared. `callbackOptIn` reflects
   * whether the caller asked for a callback during the wait.
   */
  onTimeout(params: { guardianLabel: string; callbackOptIn: boolean }): void;

  // ── Injected timing (defaults wrap the real clock/timers/config) ──────

  /** Current epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /** One-shot timer. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  /** Clears a one-shot timer. Defaults to `clearTimeout`. */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Repeating timer (polling). Defaults to `setInterval`. */
  setPollTimer?: (
    fn: () => void,
    intervalMs: number,
  ) => ReturnType<typeof setInterval>;
  /** Clears a repeating timer. Defaults to `clearInterval`. */
  clearPollTimer?: (handle: ReturnType<typeof setInterval>) => void;
  /**
   * Schedule the next heartbeat. Defaults to the shared
   * {@link scheduleNextHeartbeat} helper (which uses real `setTimeout` +
   * config intervals); overridable so tests drive heartbeats deterministically.
   */
  scheduleHeartbeat?: typeof scheduleNextHeartbeat;
  /** Look up the canonical request being polled. Defaults to the real store. */
  getCanonicalGuardianRequest?: (
    id: string,
  ) => CanonicalGuardianRequest | null | undefined;
  /** Wait timeout (ms). Defaults to {@link getUserConsultationTimeoutMs}. */
  timeoutMs?: number;
  /** Poll interval (ms). Defaults to {@link getAccessRequestPollIntervalMs}. */
  pollIntervalMs?: number;
  /**
   * Delay before the first heartbeat (so the hold message finishes first).
   * Defaults to {@link getTtsPlaybackDelayMs}.
   */
  initialHeartbeatDelayMs?: number;
  /**
   * Cooldown (ms) between reassurance replies to non-callback utterances, to
   * avoid spamming the caller. Defaults to 3000 (matching `relay-server.ts`).
   */
  inWaitReplyCooldownMs?: number;
}

const DEFAULT_IN_WAIT_REPLY_COOLDOWN_MS = 3000;

// ── Controller ───────────────────────────────────────────────────────

export class GuardianWaitController {
  private state: GuardianWaitState = "idle";

  private accessRequestId: string | null = null;
  private assistantId: string | null = null;
  private fromNumber: string | null = null;
  private callerName: string | null = null;

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
    private readonly transport: SetupFlowTransport,
    private readonly deps: GuardianWaitControllerDeps,
  ) {}

  // ── Injected-timing accessors ───────────────────────────────────────

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setTimer(
    fn: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    return this.deps.setTimer
      ? this.deps.setTimer(fn, delayMs)
      : setTimeout(fn, delayMs);
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    (this.deps.clearTimer ?? clearTimeout)(handle);
  }

  private setPollTimer(
    fn: () => void,
    intervalMs: number,
  ): ReturnType<typeof setInterval> {
    return this.deps.setPollTimer
      ? this.deps.setPollTimer(fn, intervalMs)
      : setInterval(fn, intervalMs);
  }

  private clearPollTimer(handle: ReturnType<typeof setInterval>): void {
    (this.deps.clearPollTimer ?? clearInterval)(handle);
  }

  // ── Public surface ──────────────────────────────────────────────────

  /** Explicit wait-state surface — the source of truth, never transport-derived. */
  getState(): GuardianWaitState {
    return this.state;
  }

  /**
   * Begin the bounded wait: speak the hold message, then start the heartbeat,
   * poll, and timeout timers. Polls the canonical request until it is approved
   * or denied; if neither happens within the timeout, fires `onTimeout`.
   */
  start(params: GuardianWaitStartParams): void {
    this.accessRequestId = params.accessRequestId;
    this.assistantId = params.assistantId;
    this.fromNumber = params.fromNumber;
    this.callerName = params.callerName;
    this.state = "awaiting_guardian_decision";

    const timeoutMs = this.deps.timeoutMs ?? getUserConsultationTimeoutMs();
    const pollIntervalMs =
      this.deps.pollIntervalMs ?? getAccessRequestPollIntervalMs();
    const initialHeartbeatDelayMs =
      this.deps.initialHeartbeatDelayMs ?? getTtsPlaybackDelayMs();

    const guardianLabel = this.deps.resolveGuardianLabel();
    void this.deps.speakSystemPrompt(
      this.transport,
      `Thank you. I've let ${guardianLabel} know. Please hold while I check if I have permission to speak with you.`,
    );

    // Persist the wait transition so recovery/UI paths that key off the
    // canonical call-session status observe the call is blocked on the user.
    // Mirrors relay-server.ts's `startAccessRequestWait`, which persists
    // `waiting_on_user` here, right after speaking the hold prompt.
    this.deps.markWaitingOnUser();

    // Start the heartbeat timer for periodic progress updates. Delay the first
    // heartbeat by the estimated TTS playback duration so the initial hold
    // message finishes before any heartbeat fires.
    //
    // Set the wait start time now so scheduleNextHeartbeat() always has a valid
    // reference point — even if the delay timer is cancelled early (e.g. by a
    // caller utterance during playback). The callback below re-stamps it to
    // exclude the TTS delay if it fires.
    this.heartbeatSequence = 0;
    this.waitStartedAt = this.now();
    this.heartbeatTimer = this.setTimer(() => {
      this.waitStartedAt = this.now();
      this.scheduleNextHeartbeat();
    }, initialHeartbeatDelayMs);

    // Poll the canonical request status.
    this.pollTimer = this.setPollTimer(() => {
      if (
        this.state !== "awaiting_guardian_decision" ||
        !this.accessRequestId
      ) {
        this.clearWait();
        return;
      }

      const request = this.lookupRequest(this.accessRequestId);
      if (!request) return;

      if (request.status === "approved") {
        this.handleApproved();
      } else if (request.status === "denied") {
        this.handleDenied();
      }
      // 'pending' continues polling; 'expired'/'cancelled' handled by timeout.
    }, pollIntervalMs);

    // Timeout: give up waiting for the guardian.
    this.timeoutTimer = this.setTimer(() => {
      if (this.state !== "awaiting_guardian_decision") return;
      log.info(
        { callSessionId: this.callSessionId, requestId: this.accessRequestId },
        "Guardian access-request wait timed out",
      );
      this.handleTimeout();
    }, timeoutMs);

    log.info(
      {
        callSessionId: this.callSessionId,
        requestId: this.accessRequestId,
        timeoutMs,
      },
      "Guardian access-request wait started",
    );
  }

  /**
   * Route a finalized caller transcript spoken during the wait: patience
   * checks, impatience (→ callback offer), and callback opt-in/decline.
   * No-op unless a wait is active.
   */
  handleTranscript(text: string): void {
    if (this.state !== "awaiting_guardian_decision") return;

    const now = this.now();
    const classification = classifyWaitUtterance(text, this.callbackOfferMade);

    recordCallEvent(
      this.callSessionId,
      "voice_guardian_wait_prompt_classified",
      { classification, transcript: text },
    );

    if (classification === "empty") return;

    const guardianLabel = this.deps.resolveGuardianLabel();

    // Callback decisions must always be processed regardless of cooldown — the
    // caller is answering a direct question and dropping their response would
    // silently discard their decision.
    switch (classification) {
      case "callback_opt_in": {
        this.callbackOptIn = true;
        this.lastInWaitReplyAt = now;
        recordCallEvent(
          this.callSessionId,
          "voice_guardian_wait_callback_opt_in_set",
          {},
        );
        this.resetHeartbeatTimer();
        void this.deps.speakSystemPrompt(
          this.transport,
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
        this.resetHeartbeatTimer();
        void this.deps.speakSystemPrompt(
          this.transport,
          `No problem, I'll keep holding. Still waiting on ${guardianLabel}.`,
        );
        this.scheduleNextHeartbeat();
        return;
      }
      default:
        break;
    }

    // Enforce cooldown on non-callback utterances to prevent spam.
    const cooldownMs =
      this.deps.inWaitReplyCooldownMs ?? DEFAULT_IN_WAIT_REPLY_COOLDOWN_MS;
    if (now - this.lastInWaitReplyAt < cooldownMs) {
      log.debug(
        { callSessionId: this.callSessionId },
        "In-wait reply suppressed by cooldown",
      );
      return;
    }
    this.lastInWaitReplyAt = now;

    switch (classification) {
      case "impatient": {
        this.resetHeartbeatTimer();
        if (!this.callbackOfferMade) {
          this.callbackOfferMade = true;
          recordCallEvent(
            this.callSessionId,
            "voice_guardian_wait_callback_offer_sent",
            {},
          );
          void this.deps.speakSystemPrompt(
            this.transport,
            `I understand this is taking a while. I can have ${guardianLabel} call you back once I hear from them. Would you like that, or would you prefer to keep holding?`,
          );
        } else {
          // Already offered callback — just reassure.
          void this.deps.speakSystemPrompt(
            this.transport,
            `I hear you, I'm sorry for the wait. Still trying to reach ${guardianLabel}.`,
          );
        }
        this.scheduleNextHeartbeat();
        break;
      }
      case "patience_check": {
        this.resetHeartbeatTimer();
        void this.deps.speakSystemPrompt(
          this.transport,
          `Yes, I'm still here. Still waiting to hear back from ${guardianLabel}.`,
        );
        this.scheduleNextHeartbeat();
        break;
      }
      case "neutral":
      default: {
        this.resetHeartbeatTimer();
        void this.deps.speakSystemPrompt(
          this.transport,
          `Thanks for that. I'm still waiting on ${guardianLabel}. I'll let you know as soon as I hear back.`,
        );
        this.scheduleNextHeartbeat();
        break;
      }
    }
  }

  /** Clear all timers and mark the wait resolved. Safe to call repeatedly. */
  dispose(): void {
    this.clearWait();
    this.state = "resolved";
  }

  // ── Internal ────────────────────────────────────────────────────────

  private lookupRequest(
    id: string,
  ): CanonicalGuardianRequest | null | undefined {
    return (
      this.deps.getCanonicalGuardianRequest ?? getCanonicalGuardianRequest
    )(id);
  }

  /** Clear the heartbeat timer (without touching poll/timeout). */
  private resetHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Clear every wait timer and mark the wait inactive (state untouched). */
  private clearWait(): void {
    if (this.pollTimer) {
      this.clearPollTimer(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.timeoutTimer) {
      this.clearTimer(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.resetHeartbeatTimer();
  }

  private scheduleNextHeartbeat(): void {
    const scheduler = this.deps.scheduleHeartbeat ?? scheduleNextHeartbeat;
    this.heartbeatTimer = scheduler({
      isWaitActive: () => this.state === "awaiting_guardian_decision",
      accessRequestWaitStartedAt: this.waitStartedAt,
      callSessionId: this.callSessionId,
      consumeSequence: () => this.heartbeatSequence++,
      resolveGuardianLabel: () => this.deps.resolveGuardianLabel(),
      sendTextToken: (text) =>
        void this.deps.speakSystemPrompt(this.transport, text),
      scheduleNext: () => this.scheduleNextHeartbeat(),
    });
  }

  /** Approved: clear timers, mark resolved, hand off to `onApproved`. */
  private handleApproved(): void {
    if (this.state !== "awaiting_guardian_decision") return;
    this.clearWait();
    this.state = "resolved";

    recordCallEvent(this.callSessionId, "inbound_acl_access_approved", {
      from: this.fromNumber,
      callerName: this.callerName,
      requestId: this.accessRequestId,
    });
    log.info(
      { callSessionId: this.callSessionId, from: this.fromNumber },
      "Guardian access request approved — caller activated and continuing call",
    );

    this.deps.onApproved({
      assistantId: this.assistantId!,
      fromNumber: this.fromNumber!,
      callerName: this.callerName,
    });
  }

  /** Denied: clear timers, mark resolved, hand off to `onDenied`. */
  private handleDenied(): void {
    if (this.state !== "awaiting_guardian_decision") return;
    this.clearWait();
    this.state = "resolved";

    recordCallEvent(this.callSessionId, "inbound_acl_access_denied", {
      from: this.fromNumber,
      requestId: this.accessRequestId,
    });
    log.info(
      { callSessionId: this.callSessionId },
      "Guardian access request denied — ending call",
    );

    this.deps.onDenied({ guardianLabel: this.deps.resolveGuardianLabel() });
  }

  /**
   * Timeout (or fail-closed): emit the callback-handoff notification, clear
   * timers, mark resolved, then hand off to `onTimeout`.
   */
  private handleTimeout(): void {
    if (this.state !== "awaiting_guardian_decision") return;

    // Emit the callback handoff notification before clearing wait state so the
    // opt-in flag and request identity are still available.
    const handoff = emitAccessRequestCallbackHandoff({
      reason: "timeout",
      callbackOptIn: this.callbackOptIn,
      accessRequestId: this.accessRequestId,
      callbackHandoffNotified: this.callbackHandoffNotified,
      accessRequestAssistantId: this.assistantId,
      accessRequestFromNumber: this.fromNumber,
      accessRequestCallerName: this.callerName,
      callSessionId: this.callSessionId,
    });
    this.callbackHandoffNotified = handoff.callbackHandoffNotified;

    this.clearWait();
    this.state = "resolved";

    recordCallEvent(this.callSessionId, "inbound_acl_access_timeout", {
      from: this.fromNumber,
      requestId: this.accessRequestId,
      callbackOptIn: this.callbackOptIn,
    });
    log.info(
      { callSessionId: this.callSessionId },
      "Guardian access request timed out — ending call",
    );

    this.deps.onTimeout({
      guardianLabel: this.deps.resolveGuardianLabel(),
      callbackOptIn: this.callbackOptIn,
    });
  }
}
