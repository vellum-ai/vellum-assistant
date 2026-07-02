/**
 * Transport-agnostic call setup flow.
 *
 * Runs the pre-conversation phase of a phone call — acting on the routing
 * outcome produced by `routeSetup` (relay-setup-router.ts) — against any
 * {@link SetupFlowTransport}. All side effects (speech, call-store writes,
 * completion) flow through injected deps so the flow is unit-testable and
 * independent of any wire protocol.
 *
 * Handles `normal_call`, `deny`, the three verification actions
 * (`verification`, `outbound_verification`, `callee_verification`), and
 * `invite_redemption`. Other setup actions (name capture) throw
 * {@link UnsupportedSetupFlowError}.
 */

import { randomInt } from "node:crypto";

import { getGuardianDeliveryFresh } from "../contacts/guardian-delivery-reader.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { addMessage as addMessageFn } from "../persistence/conversation-crud.js";
import {
  resolveActorTrust,
  toTrustContext,
} from "../runtime/actor-trust-resolver.js";
import {
  trustContextFromVerdict,
  verdictHasMemberIdentity,
  verdictMemberUnresolvable,
} from "../runtime/trust-verdict-consumer.js";
import {
  composeVerificationVoice,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/verification-templates.js";
import { getLogger } from "../util/logger.js";
import { getTtsPlaybackDelayMs } from "./call-constants.js";
import type { addPointerMessage as addPointerMessageFn } from "./call-pointer-messages.js";
import type {
  SetupFlowInput,
  SetupFlowResult,
  SetupFlowState,
  SetupFlowTransport,
} from "./call-setup-flow-types.js";
import type { fireCallTranscriptNotifier as fireCallTranscriptNotifierFn } from "./call-state.js";
import type {
  recordCallEvent as recordCallEventFn,
  updateCallSession as updateCallSessionFn,
} from "./call-store.js";
import type { finalizeCall as finalizeCallFn } from "./finalize-call.js";
import { getInboundTrustVerdict } from "./inbound-trust-reader.js";
import type { SetupOutcome, SetupResolved } from "./relay-setup-router.js";
import {
  attemptInviteCodeRedemption as attemptInviteCodeRedemptionImpl,
  attemptVerificationCode as attemptVerificationCodeImpl,
  parseDigitsFromSpeech,
} from "./relay-verification.js";

const log = getLogger("call-setup-flow");

const INVITE_CODE_LENGTH = 6;

// ── Errors ───────────────────────────────────────────────────────────

/** Thrown when `start()` receives a setup action the flow does not implement. */
export class UnsupportedSetupFlowError extends Error {
  constructor(action: string) {
    super(`Setup action '${action}' is not supported by CallSetupFlow`);
    this.name = "UnsupportedSetupFlowError";
  }
}

// ── Dependencies ─────────────────────────────────────────────────────

/** Structural subset of the call session that setup sub-flows read. */
export interface SetupFlowCallSession {
  conversationId: string;
  initiatedFromConversationId?: string | null;
  toNumber?: string;
}

/**
 * Side-effect surface injected into the flow. Sub-flows extend this
 * interface with additional accessors rather than reshaping the
 * constructor.
 */
export interface CallSetupFlowDeps {
  /** Speak a deterministic system prompt through the transport. */
  speakSystemPrompt(transport: SetupFlowTransport, text: string): Promise<void>;
  updateCallSession(
    id: string,
    updates: Parameters<typeof updateCallSessionFn>[1],
  ): void;
  recordCallEvent(
    callSessionId: string,
    eventType: Parameters<typeof recordCallEventFn>[1],
    payload?: Record<string, unknown>,
  ): void;
  /** Invoked exactly once when the flow reaches a terminal result. */
  onComplete(result: SetupFlowResult): void;
  /**
   * Delay between speaking terminal copy and ending the session.
   * Defaults to the configured TTS playback delay.
   */
  ttsPlaybackDelayMs?: number;

  // ── Verification / invite sub-flow deps ────────────────────────────
  // Optional so callers exercising only normal_call/deny need not supply
  // them. Each sub-flow resolves the deps it needs up front at start()
  // and throws on a missing side-effect dep (see requireVerificationDeps
  // and requireInviteDeps).
  /** Look up the call session (used for its conversation/routing fields). */
  getCallSession?(id: string): SetupFlowCallSession | null;
  finalizeCall?: typeof finalizeCallFn;
  addMessage?: typeof addMessageFn;
  addPointerMessage?: typeof addPointerMessageFn;
  fireCallTranscriptNotifier?: typeof fireCallTranscriptNotifierFn;
  /** Human-readable guardian label for prompts and handoff copy. */
  resolveGuardianLabel?(): string;
  /** Assistant display name, or null when unavailable. */
  resolveAssistantLabel?(): string | null;
  /** Defaults to {@link attemptVerificationCodeImpl} (relay-verification). */
  attemptVerificationCode?: typeof attemptVerificationCodeImpl;
  /** Gateway-native invite claim. Defaults to relay-verification's. */
  attemptInviteCodeRedemption?: typeof attemptInviteCodeRedemptionImpl;
  /**
   * Re-resolve caller trust after a successful mid-setup activation
   * (verdict-first with local fallback). Defaults to
   * {@link resolveMidCallTrustContext}; errors fail soft to the
   * setup-time trust.
   */
  resolveMidCallTrustContext?(
    assistantId: string,
    fromNumber: string,
  ): Promise<TrustContext>;
}

/** Verification deps with defaults applied and optionality removed. */
type VerificationDeps = Required<
  Pick<
    CallSetupFlowDeps,
    | "getCallSession"
    | "finalizeCall"
    | "addMessage"
    | "addPointerMessage"
    | "fireCallTranscriptNotifier"
    | "resolveGuardianLabel"
    | "resolveAssistantLabel"
    | "attemptVerificationCode"
    | "resolveMidCallTrustContext"
  >
>;

/** Invite-redemption deps with defaults applied and optionality removed. */
type InviteDeps = Required<
  Pick<
    CallSetupFlowDeps,
    | "getCallSession"
    | "finalizeCall"
    | "fireCallTranscriptNotifier"
    | "resolveGuardianLabel"
    | "resolveAssistantLabel"
    | "attemptInviteCodeRedemption"
    | "resolveMidCallTrustContext"
  >
>;

/**
 * Deps needed by the shared trusted-contact activation continuation —
 * the common subset of {@link VerificationDeps} and {@link InviteDeps}.
 */
type ActivationDeps = Pick<
  VerificationDeps,
  | "getCallSession"
  | "fireCallTranscriptNotifier"
  | "resolveGuardianLabel"
  | "resolveAssistantLabel"
  | "resolveMidCallTrustContext"
>;

// ── Module helpers ───────────────────────────────────────────────────

/**
 * Re-resolve caller trust after a mid-setup verification/activation. Prefers
 * the gateway verdict (authoritative right after the gateway updated the
 * binding); falls back to local resolution on a missing/failed/unusable
 * verdict so a blip never drops the call. Mirrors the setup path's
 * verdict-first-with-fallback condition.
 */
export async function resolveMidCallTrustContext(
  assistantId: string,
  fromNumber: string,
): Promise<TrustContext> {
  const verdict = await getInboundTrustVerdict({
    channelType: "phone",
    actorExternalId: fromNumber,
  });

  // Only a MEMBERLESS unknown verdict is treated as a stale gateway view and
  // falls back to local: the caller was just activated, and invite redemption
  // writes the channel assistant-side, so the gateway may not see the member
  // yet — local resolution has it. A MEMBERFUL unknown verdict (blocked/revoked
  // member, carrying contactId/channelId) is honored so its deny ACL is
  // enforced; falling back could lose the gateway's member status if local
  // state is stale.
  const memberlessUnknown =
    verdict?.trustClass === "unknown" && !verdictHasMemberIdentity(verdict);
  const usable =
    verdict &&
    !verdict.resolutionFailed &&
    !verdictMemberUnresolvable(verdict) &&
    !memberlessUnknown;

  if (usable) {
    return trustContextFromVerdict(verdict, {
      sourceChannel: "phone",
      conversationExternalId: fromNumber,
    });
  }

  // Warm the phone-channel guardian-delivery cache before the SYNC
  // resolveActorTrust fallback, which reads the IO-free per-channel snapshot
  // that daemon startup leaves cold for `phone`. Read fresh: gateway-side
  // binding writes don't invalidate the daemon cache, so a stale empty
  // snapshot would otherwise survive the TTL and misclassify the guardian.
  await getGuardianDeliveryFresh({ channelTypes: ["phone"] });

  return toTrustContext(
    resolveActorTrust({
      assistantId,
      sourceChannel: "phone",
      conversationExternalId: fromNumber,
      actorExternalId: fromNumber,
    }),
    fromNumber,
  );
}

/**
 * Return the first whitespace-delimited token of a name, or `null` when the
 * input is null/blank. Used for greetings so "Alice Example" -> "Alice".
 */
function firstToken(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.split(/\s+/)[0] ?? null;
}

// ── Flow ─────────────────────────────────────────────────────────────

type VerificationMode =
  | "inbound_verification"
  | "outbound_verification"
  | "callee_verification";

/** Sub-flows that collect a numeric code from the caller. */
type CodeCollectionMode = VerificationMode | "invite_redemption";

interface InviteRedemptionState {
  assistantId: string;
  fromNumber: string;
  inviteeName: string | null;
}

export class CallSetupFlow implements SetupFlowInput {
  private state: SetupFlowState = "idle";

  // ── Code-collection state (shared by verification + invite) ────────
  private codeMode: CodeCollectionMode | null = null;
  /** Shared digit buffer for code collection (DTMF + spoken digits). */
  private digitBuffer = "";
  private codeLength = 6;
  /** Setup-time trust, kept as the fallback when re-resolution fails. */
  private initialTrustContext: TrustContext | null = null;
  private trustReResolving = false;
  private deferredTranscripts: string[] = [];

  // ── Verification sub-flow state ─────────────────────────────────────
  private vdeps: VerificationDeps | null = null;
  private verificationAttempts = 0;
  private verificationMaxAttempts = 3;
  private verificationAssistantId = "";
  private verificationFromNumber = "";
  private outboundVerificationSessionId: string | null = null;
  private calleeVerificationCode: string | null = null;

  // ── Invite-redemption sub-flow state ────────────────────────────────
  private ideps: InviteDeps | null = null;
  private invite: InviteRedemptionState | null = null;
  /**
   * In-flight dedupe guard: the gateway claim is async, and a repeated
   * code (re-spoken / re-entered) arriving while it is pending must not
   * fire a second redemption that would see the invite already consumed
   * and wrongly fail the call. Set synchronously before awaiting and
   * cleared in a finally.
   */
  private inviteRedemptionInFlight = false;

  constructor(
    private readonly callSessionId: string,
    private readonly transport: SetupFlowTransport,
    private readonly deps: CallSetupFlowDeps,
  ) {}

  /** Explicit flow state — never inferred from the transport. */
  getState(): SetupFlowState {
    return this.state;
  }

  /**
   * Act on a routing outcome. Runs at most once per flow instance;
   * terminal continuation is delivered via `deps.onComplete`.
   */
  async start(outcome: SetupOutcome, resolved: SetupResolved): Promise<void> {
    if (this.state !== "idle") {
      throw new Error("CallSetupFlow.start() may only be called once");
    }

    switch (outcome.action) {
      case "normal_call":
        this.complete({
          kind: "proceed-initial-greeting",
          assistantId: resolved.assistantId,
          trustContext: toTrustContext(
            resolved.actorTrust,
            resolved.otherPartyNumber,
          ),
        });
        return;

      case "deny":
        await this.runDeny(outcome, resolved);
        return;

      case "verification":
        this.startInboundVerification(
          outcome.assistantId,
          outcome.fromNumber,
          resolved,
        );
        return;

      case "outbound_verification":
        this.startOutboundVerification(
          outcome.assistantId,
          outcome.sessionId,
          outcome.toNumber,
          resolved,
        );
        return;

      case "callee_verification":
        await this.startCalleeVerification(
          outcome.verificationConfig,
          resolved,
        );
        return;

      case "invite_redemption":
        this.startInviteRedemption(outcome, resolved);
        return;

      default:
        throw new UnsupportedSetupFlowError(outcome.action);
    }
  }

  // ── SetupFlowInput ──────────────────────────────────────────────────

  /** Feed a DTMF digit to the active sub-flow. No-op while idle/completed. */
  pushDtmfDigit(digit: string): void {
    if (!this.acceptsInput()) {
      return;
    }
    if (this.codeMode == null) {
      return;
    }
    this.digitBuffer += digit;
    if (this.digitBuffer.length < this.codeLength) {
      return;
    }
    const enteredCode = this.digitBuffer.slice(0, this.codeLength);
    this.digitBuffer = "";
    this.submitCode(enteredCode);
  }

  /** Feed a final caller transcript to the active sub-flow. No-op while idle/completed. */
  pushTranscriptFinal(text: string): void {
    if (!this.acceptsInput()) {
      return;
    }
    // Defer (don't drop) transcripts while trust is being re-resolved so a
    // verified caller's first utterance runs under the upgraded context, not
    // the stale pre-verification one. The drained buffer rides the terminal
    // result for the owning server to replay in order.
    if (this.trustReResolving) {
      this.deferredTranscripts.push(text);
      return;
    }
    if (this.codeMode == null) {
      return;
    }
    // Callee verification is DTMF-only — the callee should be entering
    // digits on their keypad, not speaking.
    if (this.codeMode === "callee_verification") {
      return;
    }
    const spokenDigits = parseDigitsFromSpeech(text);
    if (spokenDigits.length >= this.codeLength) {
      this.submitCode(spokenDigits.slice(0, this.codeLength));
    } else if (spokenDigits.length > 0) {
      void this.deps.speakSystemPrompt(
        this.transport,
        `I heard ${spokenDigits.length} digits. Please enter all ${this.codeLength} digits of your code.`,
      );
    }
  }

  // ── Sub-flows ───────────────────────────────────────────────────────

  /** Deny the call: record the ACL event, speak the denial, then hang up. */
  private async runDeny(
    outcome: Extract<SetupOutcome, { action: "deny" }>,
    resolved: SetupResolved,
  ): Promise<void> {
    this.deps.recordCallEvent(this.callSessionId, "inbound_acl_denied", {
      from: resolved.otherPartyNumber,
      trustClass: resolved.actorTrust.trustClass,
      channelId: resolved.actorTrust.memberRecord?.channel.id,
      memberPolicy: resolved.actorTrust.memberRecord?.policy,
    });
    this.deps.updateCallSession(this.callSessionId, {
      status: "failed",
      endedAt: Date.now(),
      lastError: outcome.logReason,
    });
    await this.deps.speakSystemPrompt(this.transport, outcome.message);
    this.endSessionAfterPlayback(outcome.logReason);
    this.complete({ kind: "ended", reason: outcome.logReason });
  }

  // ── Verification sub-flows ──────────────────────────────────────────

  /**
   * Inbound guardian / trusted-contact verification: the caller has a
   * pending voice challenge and must enter (or speak) their six-digit code.
   */
  private startInboundVerification(
    assistantId: string,
    fromNumber: string,
    resolved: SetupResolved,
  ): void {
    this.enterCodeCollection("inbound_verification", resolved, {
      maxAttempts: 3,
      codeLength: 6,
    });
    this.verificationAssistantId = assistantId;
    this.verificationFromNumber = fromNumber;

    this.deps.recordCallEvent(
      this.callSessionId,
      "voice_verification_started",
      {
        assistantId,
        maxAttempts: this.verificationMaxAttempts,
      },
    );

    void this.deps.speakSystemPrompt(
      this.transport,
      "Welcome. Please enter your six-digit verification code using your keypad, or speak the digits now.",
    );
  }

  /**
   * Outbound guardian verification: the system called the guardian's phone;
   * prompt them to enter the verification code via DTMF or speech.
   */
  private startOutboundVerification(
    assistantId: string,
    verificationSessionId: string,
    toNumber: string,
    resolved: SetupResolved,
  ): void {
    this.enterCodeCollection("outbound_verification", resolved, {
      maxAttempts: 3,
      codeLength: 6,
    });
    this.verificationAssistantId = assistantId;
    // For outbound guardian calls, the "to" number is the guardian's phone.
    this.verificationFromNumber = toNumber;
    this.outboundVerificationSessionId = verificationSessionId;

    this.deps.recordCallEvent(
      this.callSessionId,
      "outbound_voice_verification_started",
      {
        assistantId,
        verificationSessionId,
        maxAttempts: this.verificationMaxAttempts,
      },
    );

    void this.deps.speakSystemPrompt(
      this.transport,
      composeVerificationVoice(GUARDIAN_VERIFY_TEMPLATE_KEYS.VOICE_CALL_INTRO, {
        codeDigits: this.codeLength,
      }),
    );
  }

  /**
   * Outbound callee verification: generate a random code, post it to the
   * initiating conversation so the guardian can share it with the callee,
   * and prompt the callee to enter it. DTMF-only — speech is ignored.
   */
  private async startCalleeVerification(
    verificationConfig: { maxAttempts: number; codeLength: number },
    resolved: SetupResolved,
  ): Promise<void> {
    const vdeps = this.enterCodeCollection(
      "callee_verification",
      resolved,
      verificationConfig,
    );
    this.verificationAssistantId = resolved.assistantId;

    const maxValue = Math.pow(10, this.codeLength);
    const code = randomInt(0, maxValue)
      .toString()
      .padStart(this.codeLength, "0");
    this.calleeVerificationCode = code;

    this.deps.recordCallEvent(
      this.callSessionId,
      "callee_verification_started",
      {
        codeLength: this.codeLength,
        maxAttempts: this.verificationMaxAttempts,
      },
    );

    const spokenCode = code.split("").join(". ");
    void this.deps.speakSystemPrompt(
      this.transport,
      `Please enter the verification code: ${spokenCode}.`,
    );

    // Post the verification code to the initiating conversation so the
    // guardian (user) can share it with the callee.
    const session = vdeps.getCallSession(this.callSessionId);
    if (session?.initiatedFromConversationId) {
      const codeMsg = `\u{1F510} Verification code for call to ${session.toNumber}: ${code}`;
      await vdeps.addMessage(
        session.initiatedFromConversationId,
        "assistant",
        JSON.stringify([{ type: "text", text: codeMsg }]),
        {
          metadata: {
            userMessageChannel: "phone",
            assistantMessageChannel: "phone",
            userMessageInterface: "phone",
            assistantMessageInterface: "phone",
          },
        },
      );
    }
  }

  /** Shared entry bookkeeping for the verification code-collection sub-flows. */
  private enterCodeCollection(
    mode: VerificationMode,
    resolved: SetupResolved,
    config: { maxAttempts: number; codeLength: number },
  ): VerificationDeps {
    const vdeps = this.requireVerificationDeps();
    this.vdeps = vdeps;
    this.codeMode = mode;
    this.verificationAttempts = 0;
    this.verificationMaxAttempts = config.maxAttempts;
    this.codeLength = config.codeLength;
    this.digitBuffer = "";
    this.initialTrustContext = toTrustContext(
      resolved.actorTrust,
      resolved.otherPartyNumber,
    );
    this.state = "collecting_code";
    return vdeps;
  }

  /** Route a fully collected code to the active code-collection sub-flow. */
  private submitCode(enteredCode: string): void {
    const handler =
      this.codeMode === "invite_redemption"
        ? this.handleInviteCodeEntry(enteredCode)
        : this.codeMode === "callee_verification"
          ? this.handleCalleeCode(enteredCode)
          : this.handleVerificationCode(enteredCode);
    handler.catch((err) =>
      log.error(
        { err, callSessionId: this.callSessionId },
        "Setup code handling failed",
      ),
    );
  }

  /**
   * Validate an entered code against the pending voice guardian challenge
   * (inbound and outbound guardian verification).
   */
  private async handleVerificationCode(enteredCode: string): Promise<void> {
    const vdeps = this.vdeps;
    if (!vdeps) {
      return;
    }
    const isOutbound = this.outboundVerificationSessionId != null;
    const assistantId = this.verificationAssistantId;
    const fromNumber = this.verificationFromNumber;

    const result = await vdeps.attemptVerificationCode({
      verificationAssistantId: assistantId,
      verificationFromNumber: fromNumber,
      enteredCode,
      isOutbound,
      codeDigits: this.codeLength,
      verificationAttempts: this.verificationAttempts,
      verificationMaxAttempts: this.verificationMaxAttempts,
    });

    // A concurrent attempt may have already reached a terminal result.
    if (this.state === "completed") {
      return;
    }

    if (result.outcome === "success") {
      this.codeMode = null;
      this.digitBuffer = "";
      this.verificationAttempts = 0;

      this.deps.recordCallEvent(this.callSessionId, result.eventName, {
        verificationType: result.verificationType,
      });

      if (isOutbound) {
        await this.completeOutboundVerificationSuccess(
          vdeps,
          assistantId,
          fromNumber,
        );
      } else if (result.verificationType === "trusted_contact") {
        await this.continueAfterTrustedContactActivation(vdeps, {
          assistantId,
          fromNumber,
          activationReason: "trusted_contact_verified",
        });
      } else {
        // Inbound guardian verification — proceed to the normal call flow
        // under the upgraded trust context.
        const trustContext = await this.resolveTrustWithDeferral(
          vdeps,
          assistantId,
          fromNumber,
        );
        this.complete({
          kind: "proceed-initial-greeting",
          assistantId,
          trustContext,
          deferredTranscripts: this.drainDeferredTranscripts(),
        });
      }
      return;
    }

    if (result.outcome === "failure") {
      this.codeMode = null;
      this.verificationAttempts = result.attempts;

      this.deps.recordCallEvent(this.callSessionId, result.eventName, {
        attempts: result.attempts,
      });
      this.deps.updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: "Guardian voice verification failed — max attempts exceeded",
      });

      const session = vdeps.getCallSession(this.callSessionId);
      if (session) {
        vdeps.finalizeCall(this.callSessionId, session.conversationId);

        if (isOutbound && session.initiatedFromConversationId) {
          this.postPointerMessage(
            vdeps,
            session.initiatedFromConversationId,
            "verification_failed",
            session.toNumber,
            { channel: "phone", reason: "Max verification attempts exceeded" },
          );
        }
      }

      await this.deps.speakSystemPrompt(this.transport, result.ttsMessage);
      this.endSessionAfterPlayback("Verification failed — challenge rejected");
      this.complete({
        kind: "ended",
        reason: "Verification failed — challenge rejected",
      });
      return;
    }

    // Retry — re-prompt and keep collecting.
    this.verificationAttempts = result.attempt;
    void this.deps.speakSystemPrompt(this.transport, result.ttsMessage);
  }

  /** Compare an entered code against the generated callee verification code. */
  private async handleCalleeCode(enteredCode: string): Promise<void> {
    const vdeps = this.vdeps;
    if (!vdeps || this.calleeVerificationCode == null) {
      return;
    }

    if (enteredCode === this.calleeVerificationCode) {
      this.codeMode = null;
      this.calleeVerificationCode = null;
      this.verificationAttempts = 0;

      this.deps.recordCallEvent(
        this.callSessionId,
        "callee_verification_succeeded",
        {},
      );
      this.complete({
        kind: "proceed-initial-greeting",
        assistantId: this.verificationAssistantId,
        trustContext: this.initialTrustContext!,
      });
      return;
    }

    this.verificationAttempts++;

    if (this.verificationAttempts >= this.verificationMaxAttempts) {
      this.codeMode = null;

      this.deps.recordCallEvent(
        this.callSessionId,
        "callee_verification_failed",
        {
          attempts: this.verificationAttempts,
        },
      );
      // Mark failed immediately so a transport close during the goodbye TTS
      // window cannot race this into a terminal "completed" status.
      this.deps.updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: "Callee verification failed — max attempts exceeded",
      });

      const session = vdeps.getCallSession(this.callSessionId);
      if (session) {
        vdeps.finalizeCall(this.callSessionId, session.conversationId);
        if (session.initiatedFromConversationId) {
          this.postPointerMessage(
            vdeps,
            session.initiatedFromConversationId,
            "failed",
            session.toNumber,
            { reason: "Callee verification failed" },
          );
        }
      }

      // Wait for synthesis to complete before starting the teardown timer
      // so the caller hears the goodbye message.
      try {
        await this.deps.speakSystemPrompt(
          this.transport,
          "Verification failed. Goodbye.",
        );
      } catch (err) {
        log.error(
          { err, callSessionId: this.callSessionId },
          "System prompt TTS failed during verification teardown",
        );
      }
      this.endSessionAfterPlayback("Verification failed");
      this.complete({ kind: "ended", reason: "Verification failed" });
      return;
    }

    void this.deps.speakSystemPrompt(
      this.transport,
      "That code was incorrect. Please try again.",
    );
  }

  /**
   * Outbound guardian verification success: pointer back to the originating
   * conversation, trust upgrade, session to in_progress, then hand off to
   * the post-verification greeting.
   */
  private async completeOutboundVerificationSuccess(
    vdeps: VerificationDeps,
    assistantId: string,
    fromNumber: string,
  ): Promise<void> {
    const session = vdeps.getCallSession(this.callSessionId);
    if (session?.initiatedFromConversationId) {
      this.postPointerMessage(
        vdeps,
        session.initiatedFromConversationId,
        "verification_succeeded",
        session.toNumber,
        { channel: "phone" },
      );
    }

    const trustContext = await this.resolveTrustWithDeferral(
      vdeps,
      assistantId,
      fromNumber,
    );
    this.deps.updateCallSession(this.callSessionId, { status: "in_progress" });
    this.complete({
      kind: "proceed-post-verification-greeting",
      assistantId,
      trustContext,
      deferredTranscripts: this.drainDeferredTranscripts(),
    });
  }

  /**
   * Shared post-activation handoff for all trusted-contact success paths
   * (invite redemption, access-request approval, verification code).
   * Upgrades trust, delivers deterministic transition copy, and completes
   * with `proceed-handoff-spoken` so the controller marks the next caller
   * turn as an opening ack.
   */
  private async continueAfterTrustedContactActivation(
    adeps: ActivationDeps,
    params: {
      assistantId: string;
      fromNumber: string;
      activationReason?:
        | "invite_redeemed"
        | "access_approved"
        | "trusted_contact_verified";
      /**
       * Display name resolved from the bound contact (or, for outbound invite
       * calls, the session's recorded invitee name). Greeting uses only the
       * first whitespace-delimited token; an empty/blank value triggers the
       * neutral "Hi there" greeting rather than substituting the channel
       * address.
       */
      inviteeName?: string | null;
    },
  ): Promise<void> {
    const { assistantId, fromNumber } = params;

    this.deps.updateCallSession(this.callSessionId, { status: "in_progress" });

    const trustContext = await this.resolveTrustWithDeferral(
      adeps,
      assistantId,
      fromNumber,
    );

    const guardianLabel = adeps.resolveGuardianLabel();
    let handoffText: string;

    if (params.activationReason === "invite_redeemed") {
      const firstName = firstToken(params.inviteeName);
      const assistantName = adeps.resolveAssistantLabel();
      if (firstName) {
        handoffText = assistantName
          ? `Great, I've verified that you are ${firstName}. It's nice to meet you! I'm ${assistantName}, ${guardianLabel}'s assistant. How can I help?`
          : `Great, I've verified that you are ${firstName}. It's nice to meet you! How can I help?`;
      } else {
        handoffText = assistantName
          ? `Hi there! I'm ${assistantName}, ${guardianLabel}'s assistant. How can I help?`
          : `Hi there! How can I help?`;
      }
    } else {
      handoffText = `Great! ${guardianLabel} said I can speak with you. How can I help?`;
    }

    void this.deps.speakSystemPrompt(this.transport, handoffText);

    this.deps.recordCallEvent(this.callSessionId, "assistant_spoke", {
      text: handoffText,
    });
    const session = adeps.getCallSession(this.callSessionId);
    if (session) {
      adeps.fireCallTranscriptNotifier(
        session.conversationId,
        this.callSessionId,
        "assistant",
        handoffText,
      );
    }

    this.complete({
      kind: "proceed-handoff-spoken",
      assistantId,
      trustContext,
      deferredTranscripts: this.drainDeferredTranscripts(),
    });
  }

  /**
   * Re-resolve mid-setup trust, deferring transcripts that arrive during the
   * async window (see pushTranscriptFinal). Falls back to the setup-time
   * trust context on failure so a resolution blip can never wedge the call.
   */
  private async resolveTrustWithDeferral(
    adeps: ActivationDeps,
    assistantId: string,
    fromNumber: string,
  ): Promise<TrustContext> {
    this.trustReResolving = true;
    try {
      return await adeps.resolveMidCallTrustContext(assistantId, fromNumber);
    } catch (err) {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Mid-setup trust re-resolution failed — keeping setup-time trust",
      );
      return this.initialTrustContext!;
    } finally {
      this.trustReResolving = false;
    }
  }

  /** Post a call pointer message, tolerating an evicted origin conversation. */
  private postPointerMessage(
    vdeps: VerificationDeps,
    conversationId: string,
    event: Parameters<VerificationDeps["addPointerMessage"]>[1],
    phoneNumber: string | undefined,
    extra?: Parameters<VerificationDeps["addPointerMessage"]>[3],
  ): void {
    vdeps
      .addPointerMessage(conversationId, event, phoneNumber ?? "", extra)
      .catch((err) => {
        log.warn(
          { conversationId, err },
          "Skipping pointer write — origin conversation may no longer exist",
        );
      });
  }

  /** Hand off transcripts buffered during trust re-resolution, in order. */
  private drainDeferredTranscripts(): string[] | undefined {
    if (this.deferredTranscripts.length === 0) {
      return undefined;
    }
    const drained = this.deferredTranscripts;
    this.deferredTranscripts = [];
    return drained;
  }

  /** Resolve the verification deps, applying defaults for the pure logic. */
  private requireVerificationDeps(): VerificationDeps {
    const d = this.deps;
    const missing = (
      [
        ["getCallSession", d.getCallSession],
        ["finalizeCall", d.finalizeCall],
        ["addMessage", d.addMessage],
        ["addPointerMessage", d.addPointerMessage],
        ["fireCallTranscriptNotifier", d.fireCallTranscriptNotifier],
        ["resolveGuardianLabel", d.resolveGuardianLabel],
        ["resolveAssistantLabel", d.resolveAssistantLabel],
      ] as const
    )
      .filter(([, dep]) => dep == null)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `CallSetupFlow verification deps missing: ${missing.join(", ")}`,
      );
    }
    return {
      getCallSession: d.getCallSession!,
      finalizeCall: d.finalizeCall!,
      addMessage: d.addMessage!,
      addPointerMessage: d.addPointerMessage!,
      fireCallTranscriptNotifier: d.fireCallTranscriptNotifier!,
      resolveGuardianLabel: d.resolveGuardianLabel!,
      resolveAssistantLabel: d.resolveAssistantLabel!,
      attemptVerificationCode:
        d.attemptVerificationCode ?? attemptVerificationCodeImpl,
      resolveMidCallTrustContext:
        d.resolveMidCallTrustContext ?? resolveMidCallTrustContext,
    };
  }

  /** Resolve the invite-redemption deps, applying defaults for the pure logic. */
  private requireInviteDeps(): InviteDeps {
    const d = this.deps;
    const missing = (
      [
        ["getCallSession", d.getCallSession],
        ["finalizeCall", d.finalizeCall],
        ["fireCallTranscriptNotifier", d.fireCallTranscriptNotifier],
        ["resolveGuardianLabel", d.resolveGuardianLabel],
        ["resolveAssistantLabel", d.resolveAssistantLabel],
      ] as const
    )
      .filter(([, dep]) => dep == null)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `CallSetupFlow invite deps missing: ${missing.join(", ")}`,
      );
    }
    return {
      getCallSession: d.getCallSession!,
      finalizeCall: d.finalizeCall!,
      fireCallTranscriptNotifier: d.fireCallTranscriptNotifier!,
      resolveGuardianLabel: d.resolveGuardianLabel!,
      resolveAssistantLabel: d.resolveAssistantLabel!,
      attemptInviteCodeRedemption:
        d.attemptInviteCodeRedemption ?? attemptInviteCodeRedemptionImpl,
      resolveMidCallTrustContext:
        d.resolveMidCallTrustContext ?? resolveMidCallTrustContext,
    };
  }

  /** Tear the session down once the terminal copy has had time to play. */
  private endSessionAfterPlayback(reason: string): void {
    setTimeout(
      () => this.transport.endSession(reason),
      this.deps.ttsPlaybackDelayMs ?? getTtsPlaybackDelayMs(),
    );
  }

  // ── Invite redemption ───────────────────────────────────────────────

  /**
   * Enter the invite-redemption sub-flow for a caller with an active voice
   * invite. Prompts the caller to enter their 6-digit invite code via DTMF
   * or speech; the code is validated in a single attempt.
   */
  private startInviteRedemption(
    outcome: Extract<SetupOutcome, { action: "invite_redemption" }>,
    resolved: SetupResolved,
  ): void {
    const ideps = this.requireInviteDeps();
    this.ideps = ideps;
    this.codeMode = "invite_redemption";
    this.codeLength = INVITE_CODE_LENGTH;
    this.digitBuffer = "";
    this.inviteRedemptionInFlight = false;
    this.invite = {
      assistantId: outcome.assistantId,
      fromNumber: outcome.fromNumber,
      inviteeName: outcome.inviteeName,
    };
    this.initialTrustContext = toTrustContext(
      resolved.actorTrust,
      resolved.otherPartyNumber,
    );
    this.state = "collecting_code";

    this.deps.recordCallEvent(this.callSessionId, "invite_redemption_started", {
      assistantId: outcome.assistantId,
      codeLength: INVITE_CODE_LENGTH,
      maxAttempts: 1,
    });

    const displayFriend = firstToken(outcome.inviteeName) ?? "there";
    const displayGuardian = ideps.resolveGuardianLabel();

    let promptText: string;
    if (!resolved.isInbound) {
      const assistantName = ideps.resolveAssistantLabel();
      promptText = assistantName
        ? `Hi ${displayFriend}, this is ${assistantName}, ${displayGuardian}'s assistant. To get started, please enter the 6-digit code that ${displayGuardian} shared with you.`
        : `Hi ${displayFriend}, this is ${displayGuardian}'s assistant. To get started, please enter the 6-digit code that ${displayGuardian} shared with you.`;
    } else {
      promptText = `Welcome ${displayFriend}. Please enter the 6-digit code that ${displayGuardian} provided you to verify your identity.`;
    }
    void this.deps.speakSystemPrompt(this.transport, promptText);

    log.info(
      { callSessionId: this.callSessionId, assistantId: outcome.assistantId },
      `${resolved.isInbound ? "Inbound" : "Outbound"} voice invite redemption started`,
    );
  }

  /**
   * Validate a fully-entered invite code, deduping concurrent attempts:
   * a repeated code arriving while the async gateway redemption is still
   * in flight is ignored.
   */
  private async handleInviteCodeEntry(enteredCode: string): Promise<void> {
    const invite = this.invite;
    const ideps = this.ideps;
    if (!invite || !ideps) {
      return;
    }
    if (this.inviteRedemptionInFlight) {
      log.info(
        { callSessionId: this.callSessionId },
        "Ignoring repeated invite code — redemption already in flight",
      );
      return;
    }
    this.inviteRedemptionInFlight = true;

    try {
      await this.runInviteCodeRedemption(ideps, invite, enteredCode);
    } finally {
      this.inviteRedemptionInFlight = false;
    }
  }

  private async runInviteCodeRedemption(
    ideps: InviteDeps,
    invite: InviteRedemptionState,
    enteredCode: string,
  ): Promise<void> {
    const result = await ideps.attemptInviteCodeRedemption({
      inviteRedemptionFromNumber: invite.fromNumber,
      enteredCode,
      guardianLabel: ideps.resolveGuardianLabel(),
    });

    // A concurrent path may have already reached a terminal result.
    if (this.state === "completed") {
      return;
    }

    if (result.outcome === "success") {
      this.codeMode = null;
      this.digitBuffer = "";

      this.deps.recordCallEvent(
        this.callSessionId,
        "invite_redemption_succeeded",
        { memberId: result.memberId, inviteId: result.inviteId },
      );
      log.info(
        {
          callSessionId: this.callSessionId,
          memberId: result.memberId,
          type: result.type,
        },
        "Voice invite redemption succeeded",
      );

      await this.continueAfterTrustedContactActivation(ideps, {
        assistantId: invite.assistantId,
        fromNumber: invite.fromNumber,
        activationReason: "invite_redeemed",
        inviteeName: invite.inviteeName,
      });
    } else {
      this.codeMode = null;

      this.deps.recordCallEvent(
        this.callSessionId,
        "invite_redemption_failed",
        { attempts: 1 },
      );
      log.warn(
        { callSessionId: this.callSessionId },
        "Voice invite redemption failed — invalid or expired code",
      );

      this.deps.updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: "Voice invite redemption failed — invalid or expired code",
      });

      const failSession = ideps.getCallSession(this.callSessionId);
      if (failSession) {
        ideps.finalizeCall(this.callSessionId, failSession.conversationId);
      }

      await this.deps.speakSystemPrompt(this.transport, result.ttsMessage);
      this.endSessionAfterPlayback("Invite redemption failed");
      this.complete({ kind: "ended", reason: "Invite redemption failed" });
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private acceptsInput(): boolean {
    return this.state !== "idle" && this.state !== "completed";
  }

  private complete(result: SetupFlowResult): void {
    this.state = "completed";
    this.deps.onComplete(result);
  }
}
