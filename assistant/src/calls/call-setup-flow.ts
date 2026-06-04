/**
 * Transport-agnostic interactive call-setup state machine.
 *
 * `CallSetupFlow` owns the deterministic, pre-conversation setup phase of a
 * call: it decides what to speak/await before the assistant's first
 * conversational turn, and reports back (via {@link SetupFlowResult}) which
 * greeting/handoff continuation the controller should perform.
 *
 * It covers every `routeSetup` outcome:
 *
 * - `normal_call` → {@link SetupFlowResult} `proceed-initial-greeting`
 * - `deny` / `unverified_caller` → speak the copy, end the session, `ended`
 * - `verification` / `outbound_verification` / `callee_verification` /
 *   `invite_redemption` → collect a code, then proceed/handoff/end
 * - `name_capture` → capture the caller's name, open a canonical access
 *   request, and delegate the guardian-decision wait to a
 *   {@link GuardianWaitController}
 *
 * An off-contract action throws {@link UnsupportedSetupFlowError}.
 *
 * The flow is the source of truth for its own wait state via
 * {@link getState}; it never derives wait state from the transport.
 */

import { randomInt } from "node:crypto";

import type { TrustContext } from "../daemon/trust-context.js";
import type {
  ActorTrustContext,
  ResolveActorTrustInput,
} from "../runtime/actor-trust-resolver.js";
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
import {
  GuardianWaitController,
  type GuardianWaitControllerDeps,
} from "./guardian-wait-controller.js";
import type { SetupOutcome, SetupResolved } from "./relay-setup-router.js";
import {
  attemptInviteCodeRedemption,
  attemptVerificationCode,
  parseDigitsFromSpeech,
} from "./relay-verification.js";

/** Default silent-caller name-capture window (matches relay-server.ts). */
const DEFAULT_NAME_CAPTURE_TIMEOUT_MS = 30_000;

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
   * Compose the invite-redemption entry prompt spoken when the flow starts
   * collecting the invite code. Mirrors the per-direction copy assembled in
   * `relay-server.startInviteRedemption` (which reads the resolved
   * friend/guardian names and the assistant label). Injected so the flow
   * needn't reach into the persona/label machinery; a plain default is used
   * when the dep is absent.
   */
  composeInviteRedemptionPrompt?(input: {
    isOutbound: boolean;
    friendName: string | null;
    guardianName: string | null;
  }): string;
  /**
   * Compose the deterministic handoff copy spoken on a successful invite
   * redemption (the relay path's `continueCallAfterTrustedContactActivation`
   * with `activationReason: "invite_redeemed"`). The flow speaks the returned
   * text itself and resolves `proceed-handoff-spoken`.
   */
  composeInviteHandoffText?(input: {
    friendName: string | null;
    guardianName: string | null;
  }): string;
  /**
   * Mark the call session failed and finalize it after a terminal invite
   * redemption failure, mirroring the `updateCallSession({ status: "failed" })`
   * + `finalizeCall(...)` writes in
   * `relay-server.handleInviteCodeRedemptionResult`. Injected so the flow stays
   * storage-agnostic; best-effort (the flow still ends on rejection).
   */
  finalizeFailedCall?(reason: string): void | Promise<void>;
  /**
   * Re-resolve the caller's actor-trust context after a successful
   * verification, mirroring the relay path's post-validation
   * `resolveActorTrust(...)` call (see `relay-server.handleVerificationCodeResult`
   * and `continueCallAfterTrustedContactActivation`). The trust context resolved
   * by `routeSetup` is computed BEFORE the verification code is consumed, so a
   * caller who just verified would otherwise still be classified `unknown` and
   * lose guardian / trusted-contact permissions. When this dep is absent the
   * flow falls back to the (stale) `resolved.actorTrust`. Injected so the flow
   * stays transport- and storage-agnostic; PR 9 wires the real implementation.
   */
  resolveActorTrust?(input: ResolveActorTrustInput): ActorTrustContext;
  /**
   * Resolve a human-readable label for the guardian, used in the name-capture
   * greeting, the unverified-caller guidance, and the guardian-wait copy. A
   * plain default ("your contact") is used when the dep is absent. Injected so
   * the flow needn't reach into the contact/persona machinery.
   */
  resolveGuardianLabel?(): string;
  /**
   * Resolve the assistant's display name for the name-capture greeting (mirrors
   * `relay-server.resolveAssistantLabel`). `null` omits the self-introduction.
   */
  resolveAssistantLabel?(): string | null;
  /**
   * Compose the unknown-caller name-capture greeting. Mirrors the per-direction
   * copy assembled in `relay-server.startNameCapture`. A default is used when
   * the dep is absent.
   */
  composeNameCapturePrompt?(input: {
    guardianLabel: string;
    assistantLabel: string | null;
  }): string;
  /**
   * Compose the verification guidance spoken to a known-but-unverified caller
   * before the call ends. Mirrors `relay-server.handleUnverifiedCaller`. A
   * default is used when the dep is absent.
   */
  composeUnverifiedCallerMessage?(input: {
    displayName: string;
    isGuardian: boolean;
  }): string;
  /**
   * Compose the deterministic handoff copy spoken once the guardian approves an
   * access request. Mirrors the `activationReason: "access_approved"` branch of
   * `relay-server.continueCallAfterTrustedContactActivation`. A default is used
   * when the dep is absent.
   */
  composeAccessApprovedHandoffText?(input: { guardianLabel: string }): string;
  /**
   * Compose the deterministic copy spoken on guardian denial / wait timeout
   * before the call ends. Mirrors the copy in
   * `relay-server.handleAccessRequestDenied` / `handleAccessRequestTimeout`. A
   * default is used when the dep is absent.
   */
  composeAccessDeniedText?(input: { guardianLabel: string }): string;
  composeAccessTimeoutText?(input: {
    guardianLabel: string;
    callbackOptIn: boolean;
  }): string;
  /**
   * Create (or dedupe) the canonical access request and notify the guardian,
   * returning the request id to poll, or `null` when the guardian could not be
   * notified (no sender id) so the flow can fail closed. Mirrors
   * `relay-server.handleNameCaptureResponse`'s `notifyGuardianOfAccessRequest`
   * call. Injected so the flow stays storage-agnostic.
   */
  createAccessRequest?(input: {
    assistantId: string;
    fromNumber: string;
    callerName: string;
  }): string | null;
  /**
   * Persist the call session's transition to `waiting_on_user` when the
   * guardian wait starts. Forwarded to the {@link GuardianWaitController} (PR 7
   * made this REQUIRED there); mirrors `relay-server`'s
   * `updateCallSession({ status: "waiting_on_user" })`.
   */
  markWaitingOnUser?(): void;
  // Note: the name-capture terminal paths (denial / timeout / unverified)
  // reuse the existing {@link CallSetupFlowDeps.finalizeFailedCall} dep for the
  // `updateCallSession({ status: "failed" })` + `finalizeCall(...)` writes.
  /**
   * Timing/canonical-request overrides forwarded to the
   * {@link GuardianWaitController} so guardian-wait tests can drive timers
   * deterministically. Merged over the controller's own defaults.
   */
  guardianWaitOverrides?: Partial<
    Omit<
      GuardianWaitControllerDeps,
      | "speakSystemPrompt"
      | "resolveGuardianLabel"
      | "markWaitingOnUser"
      | "onApproved"
      | "onDenied"
      | "onTimeout"
    >
  >;
  /**
   * Factory for the guardian-wait controller. Defaults to constructing a real
   * {@link GuardianWaitController}; injectable so tests can substitute a fake.
   */
  makeGuardianWaitController?(
    callSessionId: string,
    transport: SetupFlowTransport,
    deps: GuardianWaitControllerDeps,
  ): GuardianWaitController;
  /** Silent-caller name-capture timeout (ms). Defaults to 30s. */
  nameCaptureTimeoutMs?: number;
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
  /**
   * One-shot timer used for the name-capture silence timeout. Defaults to
   * `setTimeout`; injectable so tests drive it deterministically. Must return a
   * handle accepted by {@link clearNameCaptureTimer}.
   */
  setNameCaptureTimer?: (
    fn: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  /** Clears a {@link setNameCaptureTimer} handle. Defaults to `clearTimeout`. */
  clearNameCaptureTimer?: (handle: ReturnType<typeof setTimeout>) => void;
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
  | {
      kind: "invite";
      /** Invite redemption — redeemed via the invite service. */
      assistantId: string;
      fromNumber: string;
      friendName: string | null;
      guardianName: string | null;
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

  /**
   * Active name-capture sub-flow context, if any. Holds the identity to attach
   * to the access request and the silence-timeout handle. Non-null exactly
   * while `state === "capturing_name"`.
   */
  private capturingName: {
    assistantId: string;
    fromNumber: string;
    timeoutHandle: ReturnType<typeof setTimeout> | null;
  } | null = null;

  /**
   * Active guardian-wait controller, if any. Created once a name is captured
   * and an access request is opened; disposed on teardown so its timers never
   * leak. Non-null while `state === "awaiting_guardian_decision"` (and until
   * disposed).
   */
  private guardianWait: GuardianWaitController | null = null;

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
   * Tear down the flow: dispose the guardian-wait controller (clearing its
   * timers and, if the caller had opted into a callback while a wait was still
   * active, emitting the transport-closed callback handoff) and clear the
   * name-capture silence timeout. Idempotent and safe to call on any path.
   *
   * Mirrors `relay-server.handleTransportClosed`'s wait teardown so a caller
   * who hangs up mid-wait neither leaks timers nor loses a callback handoff.
   */
  dispose(): void {
    this.clearNameCaptureTimeout();
    const controller = this.guardianWait;
    this.guardianWait = null;
    controller?.dispose();
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

      case "invite_redemption":
        return this.startInviteRedemption(outcome, resolved);

      case "name_capture":
        return this.startNameCapture(outcome, resolved);

      case "unverified_caller":
        return this.handleUnverifiedCaller(outcome);

      default:
        throw new UnsupportedSetupFlowError(
          (outcome as { action: string }).action,
        );
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
    // During name capture, the caller's response is their name.
    if (this.state === "capturing_name") {
      const callerName = text.trim();
      // Whitespace-only or empty transcript (e.g. silence/noise) — keep
      // waiting; the name-capture timeout still fires if no name ever arrives.
      if (callerName) this.handleNameCaptureResponse(callerName);
      return;
    }

    // During the guardian decision wait, route the utterance into the
    // controller for patience/impatience/callback handling.
    if (this.state === "awaiting_guardian_decision") {
      this.guardianWait?.handleTranscript(text);
      return;
    }

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
  private startCalleeVerification(
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

    // Install the collection resolver BEFORE awaiting any side effects. The
    // collecting state is already set above, so a digit completion (DTMF or
    // parsed speech) that arrives *while* the TTS/code-post side effects below
    // are still in flight would otherwise reach `finishCollection()` with a
    // null resolver, drop the completion, and hang `start()` forever.
    // Registering the resolver atomically with the collecting state — and
    // buffering an early completion in `finishCollection` as a backstop —
    // closes that race. The side effects run detached so the returned
    // `pending` promise resolves as soon as the code lands, even if a side
    // effect (e.g. the code-post write) is still outstanding.
    const pending = new Promise<SetupFlowResult>((resolve) => {
      this.resolveCollection = resolve;
    });
    // Flush any completion that landed before the resolver was installed.
    this.flushPendingCollectionResult();

    void this.runCalleeSetupSideEffects(code);

    return pending;
  }

  /**
   * Detached TTS + code-post side effects for callee verification. Run after
   * the collection resolver is installed so a completion that arrives while
   * these are in flight is captured rather than dropped (and `start()` is not
   * blocked on them). Mirrors `relay-server.startVerification`.
   */
  private async runCalleeSetupSideEffects(code: string): Promise<void> {
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
  }

  /**
   * Invite redemption: prompt an unknown caller (inbound or outbound) for the
   * 6-digit invite code their contact shared, then collect digits. Resolution
   * happens later, in {@link onInviteCode}. Ports
   * `relay-server.startInviteRedemption`.
   */
  private startInviteRedemption(
    outcome: Extract<SetupOutcome, { action: "invite_redemption" }>,
    resolved: SetupResolved,
  ): Promise<SetupFlowResult> {
    const isOutbound = !resolved.isInbound;
    this.collecting = {
      kind: "invite",
      assistantId: outcome.assistantId,
      fromNumber: outcome.fromNumber,
      friendName: outcome.friendName,
      guardianName: outcome.guardianName,
      buffer: "",
      codeLength: 6,
      // Relay grants a single invite-code attempt before failing the call.
      maxAttempts: 1,
      attempts: 0,
      resolved,
    };
    this.state = "collecting_code";

    this.deps.recordCallEvent(this.callSessionId, "invite_redemption_started", {
      assistantId: outcome.assistantId,
      codeLength: 6,
      maxAttempts: 1,
    });

    const prompt =
      this.deps.composeInviteRedemptionPrompt?.({
        isOutbound,
        friendName: outcome.friendName,
        guardianName: outcome.guardianName,
      }) ??
      `Welcome ${outcome.friendName ?? "there"}. Please enter the 6-digit code that ${
        outcome.guardianName ?? "your contact"
      } provided you to verify your identity.`;
    return this.speakAndWait(prompt);
  }

  // ── Name-capture + guardian-wait sub-flow ───────────────────────────

  /**
   * Unknown inbound caller: greet, ask for a name, and start a silence
   * timeout. The captured name (the next finalized transcript) creates a
   * canonical access request and hands off to a {@link GuardianWaitController}.
   * Ports `relay-server.startNameCapture`.
   */
  private startNameCapture(
    outcome: Extract<SetupOutcome, { action: "name_capture" }>,
    resolved: SetupResolved,
  ): Promise<SetupFlowResult> {
    const guardianLabel = this.guardianLabel();
    const assistantLabel = this.deps.resolveAssistantLabel?.() ?? null;
    const greeting =
      this.deps.composeNameCapturePrompt?.({ guardianLabel, assistantLabel }) ??
      (assistantLabel
        ? `Hi, this is ${assistantLabel}, ${guardianLabel}'s assistant. Sorry, I don't recognize this number. I'll let ${guardianLabel} know you called and see if I have permission to speak with you. Can I get your name?`
        : `Hi, this is ${guardianLabel}'s assistant. Sorry, I don't recognize this number. I'll let ${guardianLabel} know you called and see if I have permission to speak with you. Can I get your name?`);

    const timeoutMs =
      this.deps.nameCaptureTimeoutMs ?? DEFAULT_NAME_CAPTURE_TIMEOUT_MS;
    const armTimer = () => {
      if (this.state !== "capturing_name") return;
      void this.handleNameCaptureTimeout();
    };
    const timeoutHandle = this.deps.setNameCaptureTimer
      ? this.deps.setNameCaptureTimer(armTimer, timeoutMs)
      : setTimeout(armTimer, timeoutMs);

    this.capturingName = {
      assistantId: outcome.assistantId,
      fromNumber: outcome.fromNumber,
      timeoutHandle,
    };
    this.state = "capturing_name";
    this.resolved = resolved;

    this.deps.recordCallEvent(
      this.callSessionId,
      "inbound_acl_name_capture_started",
      { from: outcome.fromNumber, trustClass: resolved.actorTrust.trustClass },
    );

    void this.deps.speakSystemPrompt(this.transport, greeting);

    const pending = new Promise<SetupFlowResult>((resolve) => {
      this.resolveCollection = resolve;
    });
    this.flushPendingCollectionResult();
    return pending;
  }

  /**
   * Captured the caller's name: clear the silence timeout, record the capture,
   * create the canonical access request, and start the guardian wait. Fails
   * closed (timeout path) when no access request could be opened. Ports
   * `relay-server.handleNameCaptureResponse`.
   */
  private handleNameCaptureResponse(callerName: string): void {
    const c = this.capturingName;
    if (!c) return;
    this.clearNameCaptureTimeout();

    this.deps.recordCallEvent(this.callSessionId, "inbound_acl_name_captured", {
      from: c.fromNumber,
      callerName,
    });

    // Fail closed if no access request was opened (no guardian to notify /
    // poll target) rather than leaving the caller stuck on hold. A throw from
    // createAccessRequest (storage / guardian-notification failure) is treated
    // the same as a null return — mirroring the legacy relay path, which caught
    // notifyGuardianOfAccessRequest failures and fell through to the
    // timeout/fail-closed path. Without this, an exception would escape
    // pushTranscriptFinal() and leave start()'s promise unresolved (caller
    // stuck with no timeout message or hangup).
    let accessRequestId: string | null;
    try {
      accessRequestId =
        this.deps.createAccessRequest?.({
          assistantId: c.assistantId,
          fromNumber: c.fromNumber,
          callerName,
        }) ?? null;
    } catch (err) {
      log.warn(
        { callSessionId: this.callSessionId, err },
        "Access request creation failed after name capture — failing closed",
      );
      accessRequestId = null;
    }

    if (!accessRequestId) {
      log.warn(
        { callSessionId: this.callSessionId },
        "No access request opened after name capture — failing closed",
      );
      // Stop accepting names before the async timeout/end path so a late final
      // transcript during those awaits can't re-enter handleNameCaptureResponse
      // and start a guardian wait for an already-failing call (the success path
      // clears this in startGuardianWait; the silent-timeout path clears it in
      // handleNameCaptureTimeout).
      this.capturingName = null;
      void this.handleAccessRequestTimeoutEnded(this.guardianLabel(), false);
      return;
    }

    this.startGuardianWait({
      accessRequestId,
      assistantId: c.assistantId,
      fromNumber: c.fromNumber,
      callerName,
    });
  }

  /**
   * Construct the {@link GuardianWaitController}, transition to
   * `awaiting_guardian_decision`, and begin the bounded wait. The controller's
   * resolution callbacks complete this flow:
   * - `onApproved` → speak the approval handoff copy → `proceed-handoff-spoken`
   * - `onDenied`   → speak denial copy → `ended` (deferred hangup)
   * - `onTimeout`  → speak timeout copy → `ended` (deferred hangup)
   */
  private startGuardianWait(params: {
    accessRequestId: string;
    assistantId: string;
    fromNumber: string;
    callerName: string;
  }): void {
    this.capturingName = null;
    this.state = "awaiting_guardian_decision";

    const controllerDeps: GuardianWaitControllerDeps = {
      speakSystemPrompt: (t, text) => this.deps.speakSystemPrompt(t, text),
      resolveGuardianLabel: () => this.guardianLabel(),
      markWaitingOnUser: () => this.deps.markWaitingOnUser?.(),
      onApproved: ({ assistantId, fromNumber }) =>
        this.handleAccessRequestApproved(assistantId, fromNumber),
      onDenied: ({ guardianLabel }) =>
        void this.handleAccessRequestDenied(guardianLabel),
      onTimeout: ({ guardianLabel, callbackOptIn }) =>
        void this.handleAccessRequestTimeoutEnded(guardianLabel, callbackOptIn),
      ...this.deps.guardianWaitOverrides,
    };

    this.guardianWait = this.deps.makeGuardianWaitController
      ? this.deps.makeGuardianWaitController(
          this.callSessionId,
          this.transport,
          controllerDeps,
        )
      : new GuardianWaitController(
          this.callSessionId,
          this.transport,
          controllerDeps,
        );

    this.guardianWait.start({
      accessRequestId: params.accessRequestId,
      assistantId: params.assistantId,
      fromNumber: params.fromNumber,
      callerName: params.callerName,
    });
  }

  /**
   * Guardian approved the access request: speak the handoff copy, fire the
   * `assistant_spoke` event + transcript notifier, re-resolve the caller's
   * trust, and resolve `proceed-handoff-spoken`. Ports the
   * `activationReason: "access_approved"` branch of
   * `relay-server.continueCallAfterTrustedContactActivation`.
   */
  private handleAccessRequestApproved(
    assistantId: string,
    fromNumber: string,
  ): void {
    // The controller has resolved itself before invoking this callback; drop
    // the reference so a later dispose() is a no-op (no double teardown).
    this.guardianWait = null;
    const guardianLabel = this.guardianLabel();
    const handoffText =
      this.deps.composeAccessApprovedHandoffText?.({ guardianLabel }) ??
      `Great! ${guardianLabel} said I can speak with you. How can I help?`;

    const resolved = this.resolved ?? {
      assistantId,
      isInbound: true,
      otherPartyNumber: fromNumber,
      actorTrust: {} as ActorTrustContext,
    };

    this.deps.recordCallEvent(
      this.callSessionId,
      "inbound_acl_post_approval_handoff_spoken",
      { from: fromNumber },
    );
    this.finishCollection(
      this.speakHandoffAndComplete(handoffText, resolved, fromNumber),
    );
  }

  /** Guardian denied: speak denial copy, finalize failed, end the session. */
  private async handleAccessRequestDenied(
    guardianLabel: string,
  ): Promise<void> {
    this.guardianWait = null;
    const message =
      this.deps.composeAccessDeniedText?.({ guardianLabel }) ??
      `Sorry, ${guardianLabel} says I'm not allowed to speak with you. Goodbye.`;
    await this.finalizeFailedAccessRequest(
      "Inbound voice ACL: guardian denied access request",
    );
    await this.speakThenEnd(message, "Access request denied");
  }

  /** Wait timed out: speak timeout copy, finalize failed, end the session. */
  private async handleAccessRequestTimeoutEnded(
    guardianLabel: string,
    callbackOptIn: boolean,
  ): Promise<void> {
    this.guardianWait = null;
    const message =
      this.deps.composeAccessTimeoutText?.({ guardianLabel, callbackOptIn }) ??
      `Sorry, I can't get ahold of ${guardianLabel} right now. I'll let them know you called.${
        callbackOptIn
          ? ` I've noted that you'd like a callback — I'll pass that along to ${guardianLabel}.`
          : ""
      }`;
    await this.finalizeFailedAccessRequest(
      "Inbound voice ACL: guardian approval wait timed out",
    );
    await this.speakThenEnd(message, "Access request timed out");
  }

  /** Silent-caller name-capture timeout: speak copy, finalize, end session. */
  private async handleNameCaptureTimeout(): Promise<void> {
    this.clearNameCaptureTimeout();
    const c = this.capturingName;
    // Stop accepting names before the async finalize/TTS awaits below. Without
    // this, a late final transcript arriving during that window (common with
    // media/STT lag right as the timeout fires) would still reach
    // handleNameCaptureResponse() and start a guardian wait for a call that is
    // already being failed and scheduled for hangup. Clearing capturingName
    // makes that handler's guard short-circuit.
    this.capturingName = null;
    this.deps.recordCallEvent(
      this.callSessionId,
      "inbound_acl_name_capture_timeout",
      { from: c?.fromNumber },
    );
    await this.finalizeFailedAccessRequest(
      "Inbound voice ACL: name capture timed out",
    );
    await this.speakThenEnd(
      "Sorry, I didn't catch your name. Please try calling back. Goodbye.",
      "Name capture timed out",
    );
  }

  /**
   * Speak verification guidance to a known-but-unverified caller, then end the
   * session (deferred hangup). Ports `relay-server.handleUnverifiedCaller`.
   */
  private async handleUnverifiedCaller(
    outcome: Extract<SetupOutcome, { action: "unverified_caller" }>,
  ): Promise<SetupFlowResult> {
    this.deps.recordCallEvent(
      this.callSessionId,
      "inbound_acl_unverified_caller",
      { callSessionId: this.callSessionId, isGuardian: outcome.isGuardian },
    );

    const action = outcome.isGuardian
      ? `To verify, open your assistant's contacts page, click Verify next to the phone channel, and follow the prompts. Then call back once the verification session is active.`
      : `Please reach out to the account guardian to start a new verification session, then call back once the verification session is active.`;
    const message =
      this.deps.composeUnverifiedCallerMessage?.({
        displayName: outcome.displayName,
        isGuardian: outcome.isGuardian,
      }) ??
      `This number is registered as ${outcome.displayName}'s phone but has not been verified yet. ${action}`;

    await this.finalizeFailedAccessRequest(
      "Inbound voice ACL: caller channel unverified",
    );
    await this.deps.speakSystemPrompt(this.transport, message);
    const result = this.complete({
      kind: "ended",
      reason: "Inbound voice ACL: caller channel unverified",
    });
    this.scheduleHangup(() =>
      this.transport.endSession("Inbound voice ACL: caller channel unverified"),
    );
    return result;
  }

  /** Clear the name-capture silence timeout, if armed. */
  private clearNameCaptureTimeout(): void {
    const handle = this.capturingName?.timeoutHandle;
    if (handle == null) return;
    (this.deps.clearNameCaptureTimer ?? clearTimeout)(handle);
    if (this.capturingName) this.capturingName.timeoutHandle = null;
  }

  /**
   * Best-effort failed-call finalization for the name-capture terminal paths
   * (denial / timeout / unverified). Mirrors relay's
   * `updateCallSession({ status: "failed" })` + `finalizeCall(...)`; a storage
   * rejection never strands the flow — the session still ends.
   */
  private async finalizeFailedAccessRequest(reason: string): Promise<void> {
    try {
      await this.deps.finalizeFailedCall?.(reason);
    } catch (err) {
      log.warn(
        { callSessionId: this.callSessionId, err },
        "Skipping failed-call finalization — call session may be gone",
      );
    }
  }

  /** Pre-verification routing context, retained for the guardian-wait paths. */
  private resolved: SetupResolved | null = null;

  /** Resolve the guardian label, defaulting when the dep is absent. */
  private guardianLabel(): string {
    return this.deps.resolveGuardianLabel?.() ?? "your contact";
  }

  /** Resolver for the pending digit-collection promise (set on start). */
  private resolveCollection: ((result: SetupFlowResult) => void) | null = null;

  /**
   * Backstop buffer for a collection result that arrives before the resolver
   * is installed (e.g. a digit completion delivered while an awaited TTS /
   * code-post side effect in `startCalleeVerification` is still in flight).
   * Flushed by {@link flushPendingCollectionResult} once the resolver lands.
   */
  private pendingCollectionResult: SetupFlowResult | null = null;

  /** Speak a prompt, then return a promise that resolves once digits land. */
  private speakAndWait(prompt: string): Promise<SetupFlowResult> {
    void this.deps.speakSystemPrompt(this.transport, prompt);
    const pending = new Promise<SetupFlowResult>((resolve) => {
      this.resolveCollection = resolve;
    });
    this.flushPendingCollectionResult();
    return pending;
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
    } else if (c.kind === "invite") {
      await this.onInviteCode(c, enteredCode);
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
          trustContext: this.recomputedTrustContextFor(
            c.resolved,
            c.fromNumber,
          ),
        });
        return;
      }

      if (result.verificationType === "trusted_contact") {
        this.finishCollection(
          this.completeTrustedContactHandoff(c.resolved, c.fromNumber),
        );
        return;
      }

      // Inbound guardian success → normal call flow.
      this.finishWith({
        kind: "proceed-initial-greeting",
        assistantId: c.assistantId,
        trustContext: this.recomputedTrustContextFor(c.resolved, c.fromNumber),
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
        trustContext: this.recomputedTrustContextFor(
          c.resolved,
          c.resolved.otherPartyNumber,
        ),
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
   * Redeem an entered invite code via the extracted
   * `attemptInviteCodeRedemption`. On success (newly redeemed or already a
   * member), re-resolve trust, speak the invite handoff copy, and resolve
   * `proceed-handoff-spoken`. On failure, finalize the call as failed, speak
   * the failure copy, and end the session. Ports
   * `relay-server.handleInviteCodeRedemptionResult`.
   */
  private async onInviteCode(
    c: Extract<CodeCollection, { kind: "invite" }>,
    enteredCode: string,
  ): Promise<void> {
    const result = attemptInviteCodeRedemption({
      inviteRedemptionAssistantId: c.assistantId,
      inviteRedemptionFromNumber: c.fromNumber,
      enteredCode,
      inviteRedemptionGuardianName: c.guardianName,
    });

    if (result.outcome === "success") {
      this.deps.recordCallEvent(
        this.callSessionId,
        "invite_redemption_succeeded",
        {
          memberId: result.memberId,
          ...(result.inviteId ? { inviteId: result.inviteId } : {}),
        },
      );
      this.finishCollection(this.completeInviteHandoff(c));
      return;
    }

    this.deps.recordCallEvent(this.callSessionId, "invite_redemption_failed", {
      attempts: 1,
    });
    // Best-effort: mirror relay's failed-call finalization, but never let a
    // storage rejection strand the flow — the session must still end.
    try {
      await this.deps.finalizeFailedCall?.(
        "Voice invite redemption failed — invalid or expired code",
      );
    } catch (err) {
      log.warn(
        { callSessionId: this.callSessionId, err },
        "Skipping failed-call finalization — call session may be gone",
      );
    }
    await this.speakThenEnd(result.ttsMessage, "Invite redemption failed");
  }

  /**
   * Successful invite redemption: compose the invite handoff copy and complete
   * via {@link speakHandoffAndComplete}. Ports the
   * `activationReason: "invite_redeemed"` branch of
   * `relay-server.continueCallAfterTrustedContactActivation`.
   */
  private completeInviteHandoff(
    c: Extract<CodeCollection, { kind: "invite" }>,
  ): SetupFlowResult {
    const handoffText =
      this.deps.composeInviteHandoffText?.({
        friendName: c.friendName,
        guardianName: c.guardianName,
      }) ??
      (c.friendName
        ? `Great, I've verified that you are ${c.friendName}. It's nice to meet you! How can I help?`
        : "Great, I've verified your identity. It's nice to meet you! How can I help?");

    return this.speakHandoffAndComplete(handoffText, c.resolved, c.fromNumber);
  }

  /**
   * Shared "handoff already spoken" completion used by the trusted-contact and
   * invite success paths: speak the handoff copy, fire the `assistant_spoke`
   * event + transcript notifier, re-resolve the verified party's trust, and
   * resolve `proceed-handoff-spoken`.
   */
  private speakHandoffAndComplete(
    handoffText: string,
    resolved: SetupResolved,
    partyNumber: string,
  ): SetupFlowResult {
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
      trustContext: this.recomputedTrustContextFor(resolved, partyNumber),
    });
  }

  /**
   * Inbound trusted-contact success: speak the handoff copy, fire the
   * `assistant_spoke` event + transcript notifier, and resolve
   * `proceed-handoff-spoken`. Ports
   * `relay-server.continueCallAfterTrustedContactActivation`.
   */
  private completeTrustedContactHandoff(
    resolved: SetupResolved,
    partyNumber: string,
  ): SetupFlowResult {
    const handoffText =
      this.deps.composeTrustedContactHandoffText?.() ??
      "Great! You're verified. How can I help?";

    return this.speakHandoffAndComplete(handoffText, resolved, partyNumber);
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
    if (resolve) {
      resolve(result);
      return;
    }
    // Resolver not yet installed (an early completion landed mid-await) —
    // buffer the result so it isn't dropped; flushed once the resolver lands.
    this.pendingCollectionResult = result;
  }

  /**
   * Resolve a buffered collection result, if one landed before the resolver
   * was installed. Called right after the resolver is registered.
   */
  private flushPendingCollectionResult(): void {
    const buffered = this.pendingCollectionResult;
    if (buffered == null) return;
    this.pendingCollectionResult = null;
    this.finishCollection(buffered);
  }

  /**
   * Post a lifecycle pointer message to the originating conversation, if one
   * exists. No-op when the session has no originating conversation or the
   * `addPointerMessage` dep is absent.
   *
   * Best-effort: the pointer write is wrapped in a try/catch (log + continue)
   * so a rejection — e.g. the originating desktop conversation was deleted, or
   * a DB write fails — can never propagate out of the verification handlers and
   * strand the flow in `collecting_code` after the code was already consumed.
   * Mirrors relay-server, which `.catch()`es every `addPointerMessage` write
   * and continues. The verification result (proceed/ended) must be emitted
   * regardless of the pointer-write outcome.
   */
  private async postPointer(
    event: "verification_succeeded" | "verification_failed" | "failed",
    extra?: { channel?: string; reason?: string },
  ): Promise<void> {
    const session = this.deps.getSession?.();
    if (!session?.initiatedFromConversationId) return;
    try {
      await this.deps.addPointerMessage?.(
        session.initiatedFromConversationId,
        event,
        session.toNumber,
        extra,
      );
    } catch (err) {
      log.warn(
        {
          callSessionId: this.callSessionId,
          conversationId: session.initiatedFromConversationId,
          event,
          err,
        },
        "Skipping pointer write — origin conversation may no longer exist",
      );
    }
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

  /**
   * Re-resolve the actor-trust context after a successful verification so the
   * controller is created with POST-verification trust. Mirrors the relay
   * path's `resolveActorTrust(...)` re-resolution
   * (`relay-server.handleVerificationCodeResult` /
   * `continueCallAfterTrustedContactActivation`). Falls back to the stale
   * `resolved.actorTrust` when the `resolveActorTrust` dep is not wired.
   *
   * @param resolved   The pre-verification routing context.
   * @param partyNumber The verified party's number (E.164) — the guardian's
   *   number for guardian/outbound, the called party for callee verification.
   */
  private recomputedTrustContextFor(
    resolved: SetupResolved,
    partyNumber: string,
  ): TrustContext {
    if (!this.deps.resolveActorTrust) {
      return this.trustContextFor(resolved);
    }
    const updatedTrust = this.deps.resolveActorTrust({
      assistantId: resolved.assistantId,
      sourceChannel: "phone",
      conversationExternalId: partyNumber,
      actorExternalId: partyNumber || undefined,
    });
    return toTrustContext(updatedTrust, partyNumber);
  }
}
