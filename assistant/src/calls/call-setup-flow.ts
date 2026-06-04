/**
 * Transport-agnostic interactive call-setup state machine.
 *
 * `CallSetupFlow` owns the deterministic, pre-conversation setup phase of a
 * call: it decides what to speak/await before the assistant's first
 * conversational turn, and reports back (via {@link SetupFlowResult}) which
 * greeting/handoff continuation the controller should perform.
 *
 * This is the scaffold introduced by PR 2 of the media-stream migration. It
 * implements only the two terminal-in-one-step routing outcomes:
 *
 * - `normal_call` → {@link SetupFlowResult} `proceed-initial-greeting`
 * - `deny` → speak the denial copy, end the session, `ended`
 *
 * Every other `routeSetup` outcome throws {@link UnsupportedSetupFlowError};
 * later PRs (5/6/7/8) add the verification / invite / name-capture
 * sub-flows, and PR 9 wires the flow into the media-stream transport.
 *
 * The flow is the source of truth for its own wait state via
 * {@link getState}; it never derives wait state from the transport.
 */

import { randomInt } from "node:crypto";

import type { TrustContext } from "../daemon/trust-context.js";
import { toTrustContext } from "../runtime/actor-trust-resolver.js";
import {
  composeVerificationVoice,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/verification-templates.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getTtsPlaybackDelayMs } from "./call-constants.js";
import type {
  SetupFlowInput,
  SetupFlowResult,
  SetupFlowState,
  SetupFlowTransport,
} from "./call-setup-flow-types.js";
import type { SetupOutcome, SetupResolved } from "./relay-setup-router.js";
import {
  attemptVerificationCode,
  parseDigitsFromSpeech,
} from "./relay-verification.js";

const log = getLogger("call-setup-flow");

// ── Errors ───────────────────────────────────────────────────────────

/**
 * Thrown when {@link CallSetupFlow.start} is asked to handle a routing
 * outcome that this scaffold does not yet implement. Surfacing this as a
 * typed error (rather than silently no-op'ing) ensures the missing sub-flow
 * is caught loudly during the staged migration.
 */
export class UnsupportedSetupFlowError extends AssistantError {
  constructor(action: string) {
    super(`Unsupported call-setup action: ${action}`, ErrorCode.DAEMON_ERROR);
    this.name = "UnsupportedSetupFlowError";
  }
}

// ── Dependencies ─────────────────────────────────────────────────────

/**
 * The structural subset of a call-session row the verification sub-flows
 * read: the voice conversation, the dialed number, and the originating
 * (desktop) conversation a pointer/code message is posted back to.
 */
export interface SetupFlowSession {
  conversationId: string;
  toNumber: string;
  initiatedFromConversationId: string | null;
}

/**
 * Injected collaborators. Functions are injected (rather than imported
 * directly) so the flow can be unit-tested without a live transport, TTS
 * provider, or database.
 */
export interface CallSetupFlowDeps {
  /** Speak a deterministic prompt through the transport's TTS path. */
  speakSystemPrompt(transport: SetupFlowTransport, text: string): Promise<void>;
  /** Record a setup-related call event (call-store accessor). */
  recordCallEvent(
    callSessionId: string,
    eventType: string,
    payload?: Record<string, unknown>,
  ): void;
  /** Invoked once the flow resolves, with its terminal result. */
  onComplete(result: SetupFlowResult): void;
  /**
   * Read the call-session row backing this flow. Used by the verification
   * sub-flows to find the originating conversation (for code-post / pointer
   * messages) and to fire transcript notifiers. Returns `null` when the
   * session is gone. Injected so the flow stays storage-agnostic.
   */
  getSession?(): SetupFlowSession | null;
  /**
   * Post the generated callee-verification code to the originating
   * conversation so the user can relay it to the callee. Mirrors the
   * `addMessage(...)` write in `relay-server.startVerification`.
   */
  postCalleeVerificationCode?(
    conversationId: string,
    toNumber: string,
    code: string,
  ): Promise<void>;
  /**
   * Write a lifecycle pointer message into the originating conversation
   * (outbound verification success/failure). Mirrors `addPointerMessage`.
   */
  addPointerMessage?(
    conversationId: string,
    event: "verification_succeeded" | "verification_failed" | "failed",
    phoneNumber: string,
    extra?: { channel?: string; reason?: string },
  ): Promise<void>;
  /**
   * Fire the call-transcript notifier for UI subscribers. Mirrors
   * `fireCallTranscriptNotifier`. Injected so the flow needn't reach into
   * the call-state module directly.
   */
  fireTranscript?(
    conversationId: string,
    callSessionId: string,
    speaker: "caller" | "assistant",
    text: string,
  ): void;
  /**
   * Compose the deterministic trusted-contact handoff copy spoken on inbound
   * trusted-contact verification success (the relay path's
   * `continueCallAfterTrustedContactActivation`). The flow speaks the
   * returned text itself and resolves `proceed-handoff-spoken`.
   */
  composeTrustedContactHandoffText?(): string;
  /**
   * Delay (ms) to wait after speaking a terminal prompt before tearing down
   * the transport, so queued TTS playback isn't flushed by `endSession()`.
   * Defaults to {@link getTtsPlaybackDelayMs}; overridable (e.g. `0`) so unit
   * tests don't sleep for real seconds.
   */
  hangupDelayMs?: number;
  /**
   * Scheduler used to defer the transport teardown. Defaults to `setTimeout`;
   * injectable so tests can drive timers deterministically. Must invoke `fn`
   * after roughly `delayMs`.
   */
  schedule?: (fn: () => void, delayMs: number) => void;
}

// ── Digit-collection sub-flow ────────────────────────────────────────

/**
 * Which verification variant is collecting digits, plus its mutable buffer
 * and attempt state. The discriminant selects the success / retry / failure
 * branching when a full code arrives, mirroring the relay handlers.
 */
type CodeCollection = {
  /** Per-attempt buffer fed by DTMF and parsed speech. */
  buffer: string;
  codeLength: number;
  maxAttempts: number;
  attempts: number;
  resolved: SetupResolved;
} & (
  | {
      kind: "guardian";
      /** Inbound guardian challenge — validated via the channel service. */
      assistantId: string;
      fromNumber: string;
    }
  | {
      kind: "outbound";
      /** Outbound guardian verification — the dialed guardian's number. */
      assistantId: string;
      fromNumber: string;
    }
  | {
      kind: "callee";
      /** Outbound callee verification — compared against this generated code. */
      expectedCode: string;
    }
);

// ── Flow ─────────────────────────────────────────────────────────────

export class CallSetupFlow implements SetupFlowInput {
  private state: SetupFlowState = "idle";

  /**
   * Active digit-collection sub-flow, if any. Holds the per-attempt buffer,
   * attempt counters, and the success/failure branching specific to which
   * verification action is in flight. Non-null exactly while
   * `state === "collecting_code"`.
   */
  private collecting: CodeCollection | null = null;

  constructor(
    private readonly callSessionId: string,
    private readonly transport: SetupFlowTransport,
    private readonly deps: CallSetupFlowDeps,
  ) {}

  /** Explicit wait-state surface — the source of truth, never transport-derived. */
  getState(): SetupFlowState {
    return this.state;
  }

  /**
   * Drive the setup flow for a routed outcome. Returns the continuation the
   * controller should perform, and also delivers it via `deps.onComplete`.
   *
   * Only `normal_call` and `deny` are implemented in this scaffold; any
   * other action throws {@link UnsupportedSetupFlowError}.
   */
  async start(
    outcome: SetupOutcome,
    resolved: SetupResolved,
  ): Promise<SetupFlowResult> {
    switch (outcome.action) {
      case "normal_call":
        return this.complete({
          kind: "proceed-initial-greeting",
          assistantId: resolved.assistantId,
          trustContext: this.trustContextFor(resolved),
        });

      case "deny":
        return this.handleDeny(outcome);

      case "verification":
        return this.startGuardianVerification(outcome, resolved);

      case "outbound_verification":
        return this.startOutboundVerification(outcome, resolved);

      case "callee_verification":
        return this.startCalleeVerification(outcome, resolved);

      default:
        throw new UnsupportedSetupFlowError(outcome.action);
    }
  }

  // ── SetupFlowInput ──────────────────────────────────────────────────
  // Feed caller input into the active digit-collection sub-flow (if any).
  // Both DTMF and parsed speech append to a single shared buffer; the buffer
  // is consumed once `codeLength` digits have accumulated.

  pushDtmfDigit(digit: string): void {
    if (!this.collecting) return;
    this.appendDigits(digit);
  }

  pushTranscriptFinal(text: string): void {
    if (!this.collecting) return;
    const digits = parseDigitsFromSpeech(text);
    if (digits.length === 0) return;
    this.appendDigits(digits);
  }

  // ── Verification sub-flows ──────────────────────────────────────────

  /**
   * Inbound guardian challenge: prompt for the six-digit code and begin
   * collecting digits. Resolution happens later, in {@link onFullCode}.
   * Ports `relay-server.startInboundVerification`.
   */
  private startGuardianVerification(
    outcome: Extract<SetupOutcome, { action: "verification" }>,
    resolved: SetupResolved,
  ): Promise<SetupFlowResult> {
    this.collecting = {
      kind: "guardian",
      assistantId: outcome.assistantId,
      fromNumber: outcome.fromNumber,
      buffer: "",
      codeLength: 6,
      maxAttempts: 3,
      attempts: 0,
      resolved,
    };
    this.state = "collecting_code";

    this.deps.recordCallEvent(
      this.callSessionId,
      "voice_verification_started",
      { assistantId: outcome.assistantId, maxAttempts: 3 },
    );
    return this.speakAndWait(
      "Welcome. Please enter your six-digit verification code using your keypad, or speak the digits now.",
    );
  }

  /**
   * Outbound guardian verification: the system dialed the guardian; prompt
   * them to enter the code. Ports `relay-server.startOutboundVerification`.
   */
  private startOutboundVerification(
    outcome: Extract<SetupOutcome, { action: "outbound_verification" }>,
    resolved: SetupResolved,
  ): Promise<SetupFlowResult> {
    const codeLength = 6;
    this.collecting = {
      kind: "outbound",
      assistantId: outcome.assistantId,
      // For outbound guardian calls the "to" number is the guardian's phone.
      fromNumber: outcome.toNumber,
      buffer: "",
      codeLength,
      maxAttempts: 3,
      attempts: 0,
      resolved,
    };
    this.state = "collecting_code";

    this.deps.recordCallEvent(
      this.callSessionId,
      "outbound_voice_verification_started",
      {
        assistantId: outcome.assistantId,
        verificationSessionId: outcome.sessionId,
        maxAttempts: 3,
      },
    );
    return this.speakAndWait(
      composeVerificationVoice(GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_CALL_INTRO, {
        codeDigits: codeLength,
      }),
    );
  }

  /**
   * Outbound callee verification: generate a code, speak it digit-by-digit,
   * post it to the originating conversation, and collect the callee's entry.
   * Ports `relay-server.startVerification`.
   */
  private async startCalleeVerification(
    outcome: Extract<SetupOutcome, { action: "callee_verification" }>,
    resolved: SetupResolved,
  ): Promise<SetupFlowResult> {
    const { codeLength, maxAttempts } = outcome.verificationConfig;
    const code = randomInt(0, Math.pow(10, codeLength))
      .toString()
      .padStart(codeLength, "0");

    this.collecting = {
      kind: "callee",
      expectedCode: code,
      buffer: "",
      codeLength,
      maxAttempts,
      attempts: 0,
      resolved,
    };
    this.state = "collecting_code";

    this.deps.recordCallEvent(
      this.callSessionId,
      "callee_verification_started",
      { codeLength, maxAttempts },
    );

    // Speak the code digit-by-digit and prompt for entry.
    const spokenCode = code.split("").join(". ");
    await this.deps.speakSystemPrompt(
      this.transport,
      `Please enter the verification code: ${spokenCode}.`,
    );

    // Post the code to the originating conversation so the user can relay it.
    const session = this.deps.getSession?.();
    if (session?.initiatedFromConversationId) {
      await this.deps.postCalleeVerificationCode?.(
        session.initiatedFromConversationId,
        session.toNumber,
        code,
      );
    }

    return new Promise<SetupFlowResult>((resolve) => {
      this.resolveCollection = resolve;
    });
  }

  /** Resolver for the pending digit-collection promise (set on start). */
  private resolveCollection: ((result: SetupFlowResult) => void) | null = null;

  /** Speak a prompt, then return a promise that resolves once digits land. */
  private speakAndWait(prompt: string): Promise<SetupFlowResult> {
    void this.deps.speakSystemPrompt(this.transport, prompt);
    return new Promise<SetupFlowResult>((resolve) => {
      this.resolveCollection = resolve;
    });
  }

  /** Append digits to the active buffer; consume once a full code arrives. */
  private appendDigits(digits: string): void {
    const c = this.collecting;
    if (!c) return;
    c.buffer += digits;
    if (c.buffer.length >= c.codeLength) {
      const enteredCode = c.buffer.slice(0, c.codeLength);
      c.buffer = "";
      void this.onFullCode(enteredCode);
    }
  }

  /** Branch on a fully-entered code per the active sub-flow. */
  private async onFullCode(enteredCode: string): Promise<void> {
    const c = this.collecting;
    if (!c) return;
    if (c.kind === "callee") {
      await this.onCalleeCode(c, enteredCode);
    } else {
      await this.onGuardianCode(c, enteredCode);
    }
  }

  /**
   * Validate a guardian (inbound or outbound) code via the extracted
   * `attemptVerificationCode` and apply the relay-parity side effects.
   */
  private async onGuardianCode(
    c: Extract<CodeCollection, { kind: "guardian" | "outbound" }>,
    enteredCode: string,
  ): Promise<void> {
    const isOutbound = c.kind === "outbound";
    const result = attemptVerificationCode({
      verificationAssistantId: c.assistantId,
      verificationFromNumber: c.fromNumber,
      enteredCode,
      isOutbound,
      codeDigits: c.codeLength,
      verificationAttempts: c.attempts,
      verificationMaxAttempts: c.maxAttempts,
    });

    if (result.outcome === "success") {
      this.deps.recordCallEvent(this.callSessionId, result.eventName, {
        verificationType: result.verificationType,
      });

      if (isOutbound) {
        await this.postPointer("verification_succeeded", { channel: "phone" });
        this.finishWith({
          kind: "proceed-post-verification-greeting",
          assistantId: c.assistantId,
          trustContext: this.trustContextFor(c.resolved),
        });
        return;
      }

      if (result.verificationType === "trusted_contact") {
        this.finishCollection(this.completeTrustedContactHandoff(c.resolved));
        return;
      }

      // Inbound guardian success → normal call flow.
      this.finishWith({
        kind: "proceed-initial-greeting",
        assistantId: c.assistantId,
        trustContext: this.trustContextFor(c.resolved),
      });
      return;
    }

    if (result.outcome === "failure") {
      c.attempts = result.attempts;
      this.deps.recordCallEvent(this.callSessionId, result.eventName, {
        attempts: result.attempts,
      });

      if (isOutbound) {
        await this.postPointer("verification_failed", {
          channel: "phone",
          reason: "Max verification attempts exceeded",
        });
      }

      await this.speakThenEnd(
        result.ttsMessage,
        "Verification failed — challenge rejected",
      );
      return;
    }

    // retry
    c.attempts = result.attempt;
    void this.deps.speakSystemPrompt(this.transport, result.ttsMessage);
  }

  /**
   * Compare a callee-entered code against the generated code; on success
   * proceed to the initial greeting, else retry up to max then end.
   * Ports the callee branch of `relay-server.handleDtmf`.
   */
  private async onCalleeCode(
    c: Extract<CodeCollection, { kind: "callee" }>,
    enteredCode: string,
  ): Promise<void> {
    if (enteredCode === c.expectedCode) {
      this.deps.recordCallEvent(
        this.callSessionId,
        "callee_verification_succeeded",
        {},
      );
      this.finishWith({
        kind: "proceed-initial-greeting",
        assistantId: c.resolved.assistantId,
        trustContext: this.trustContextFor(c.resolved),
      });
      return;
    }

    c.attempts += 1;
    if (c.attempts >= c.maxAttempts) {
      this.deps.recordCallEvent(
        this.callSessionId,
        "callee_verification_failed",
        { attempts: c.attempts },
      );
      await this.postPointer("failed", {
        reason: "Callee verification failed",
      });
      await this.speakThenEnd(
        "Verification failed. Goodbye.",
        "Verification failed",
      );
      return;
    }

    void this.deps.speakSystemPrompt(
      this.transport,
      "That code was incorrect. Please try again.",
    );
  }

  /**
   * Inbound trusted-contact success: speak the handoff copy, fire the
   * `assistant_spoke` event + transcript notifier, and resolve
   * `proceed-handoff-spoken`. Ports
   * `relay-server.continueCallAfterTrustedContactActivation`.
   */
  private completeTrustedContactHandoff(
    resolved: SetupResolved,
  ): SetupFlowResult {
    const handoffText =
      this.deps.composeTrustedContactHandoffText?.() ??
      "Great! You're verified. How can I help?";

    void this.deps.speakSystemPrompt(this.transport, handoffText);
    this.deps.recordCallEvent(this.callSessionId, "assistant_spoke", {
      text: handoffText,
    });
    const session = this.deps.getSession?.();
    if (session) {
      this.deps.fireTranscript?.(
        session.conversationId,
        this.callSessionId,
        "assistant",
        handoffText,
      );
    }

    return this.complete({
      kind: "proceed-handoff-spoken",
      assistantId: resolved.assistantId,
      trustContext: this.trustContextFor(resolved),
    });
  }

  /**
   * Terminal "failure → ended" speech: speak the message, resolve `ended`,
   * and defer the transport teardown by the playback delay (same deferral
   * pattern as the deny path) so the failure audio has time to play.
   */
  private async speakThenEnd(message: string, reason: string): Promise<void> {
    await this.deps.speakSystemPrompt(this.transport, message);
    this.finishWith({ kind: "ended", reason });
    this.scheduleHangup(() => this.transport.endSession(reason));
  }

  /** Complete the flow and resolve the pending collection start() promise. */
  private finishWith(result: SetupFlowResult): void {
    this.finishCollection(this.complete(result));
  }

  /** Clear the collection state and resolve the pending start() promise. */
  private finishCollection(result: SetupFlowResult): void {
    this.collecting = null;
    const resolve = this.resolveCollection;
    this.resolveCollection = null;
    resolve?.(result);
  }

  /**
   * Post a lifecycle pointer message to the originating conversation, if one
   * exists. No-op when the session has no originating conversation or the
   * `addPointerMessage` dep is absent.
   */
  private async postPointer(
    event: "verification_succeeded" | "verification_failed" | "failed",
    extra?: { channel?: string; reason?: string },
  ): Promise<void> {
    const session = this.deps.getSession?.();
    if (!session?.initiatedFromConversationId) return;
    await this.deps.addPointerMessage?.(
      session.initiatedFromConversationId,
      event,
      session.toNumber,
      extra,
    );
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * Speak the denial copy, then resolve as `ended`. The transport teardown is
   * deferred by the TTS playback delay so the denial audio has time to play —
   * `endSession()` flushes any queued playback (e.g. on `MediaStreamOutput`),
   * so calling it synchronously after `speakSystemPrompt()` (which only
   * guarantees the audio was queued, not heard) would cut off the message.
   *
   * Mirrors the deny paths in `relay-server.ts` and `media-stream-server.ts`:
   * the session is reported ended immediately, but the actual transport
   * `endSession()` fires only after the (injectable) delay via a scheduled
   * timer — it never blocks the event loop with a real sleep.
   */
  private async handleDeny(
    outcome: Extract<SetupOutcome, { action: "deny" }>,
  ): Promise<SetupFlowResult> {
    this.deps.recordCallEvent(this.callSessionId, "inbound_acl_denied", {
      logReason: outcome.logReason,
    });
    await this.deps.speakSystemPrompt(this.transport, outcome.message);
    const result = this.complete({ kind: "ended", reason: outcome.logReason });
    this.scheduleHangup(() => this.transport.endSession(outcome.logReason));
    return result;
  }

  /** Defer a transport teardown by the (overridable) TTS playback delay. */
  private scheduleHangup(fn: () => void): void {
    const delayMs = this.deps.hangupDelayMs ?? getTtsPlaybackDelayMs();
    const schedule = this.deps.schedule ?? setTimeout;
    schedule(fn, delayMs);
  }

  /** Mark the flow completed, notify via `onComplete`, and return the result. */
  private complete(result: SetupFlowResult): SetupFlowResult {
    this.state = "completed";
    log.info(
      { callSessionId: this.callSessionId, kind: result.kind },
      "Call setup flow completed",
    );
    this.deps.onComplete(result);
    return result;
  }

  private trustContextFor(resolved: SetupResolved): TrustContext {
    return toTrustContext(resolved.actorTrust, resolved.otherPartyNumber);
  }
}
