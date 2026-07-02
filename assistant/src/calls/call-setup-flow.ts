/**
 * Transport-agnostic call setup flow.
 *
 * Runs the pre-conversation phase of a phone call — acting on the routing
 * outcome produced by `routeSetup` (relay-setup-router.ts) — against any
 * {@link SetupFlowTransport}. All side effects (speech, call-store writes,
 * completion) flow through injected deps so the flow is unit-testable and
 * independent of any wire protocol.
 *
 * Handles `normal_call`, `deny`, and `invite_redemption`. Other setup
 * actions (verification, name capture) throw {@link UnsupportedSetupFlowError}.
 */

import type { TrustContext } from "../daemon/trust-context.js";
import { toTrustContext } from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
import { getTtsPlaybackDelayMs } from "./call-constants.js";
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
import type { SetupOutcome, SetupResolved } from "./relay-setup-router.js";
import {
  type attemptInviteCodeRedemption as attemptInviteCodeRedemptionFn,
  parseDigitsFromSpeech,
} from "./relay-verification.js";

const log = getLogger("call-setup-flow");

const INVITE_CODE_LENGTH = 6;

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

// ── Errors ───────────────────────────────────────────────────────────

/** Thrown when `start()` receives a setup action the flow does not implement. */
export class UnsupportedSetupFlowError extends Error {
  constructor(action: string) {
    super(`Setup action '${action}' is not supported by CallSetupFlow`);
    this.name = "UnsupportedSetupFlowError";
  }
}

// ── Dependencies ─────────────────────────────────────────────────────

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

  // ── Invite-redemption sub-flow dependencies ─────────────────────────

  /** Gateway-native invite claim (relay-verification.ts). */
  attemptInviteCodeRedemption: typeof attemptInviteCodeRedemptionFn;
  /** Human-readable guardian label for prompts and handoff copy. */
  resolveGuardianLabel(): string;
  /** Assistant display name, or null when unavailable/UUID-shaped. */
  resolveAssistantLabel(): string | null;
  /** Look up the call session (used for its conversationId). */
  getCallSession(id: string): { conversationId: string } | null;
  /** Persist the call-completion message and fire completion notifiers. */
  finalizeCall(callSessionId: string, conversationId: string): void;
  fireCallTranscriptNotifier: typeof fireCallTranscriptNotifierFn;
  /**
   * Re-resolve caller trust after a successful activation (verdict-first
   * with local fallback). Errors fail soft to the setup-time trust.
   */
  resolveMidCallTrustContext(
    assistantId: string,
    fromNumber: string,
  ): Promise<TrustContext>;
}

// ── Sub-flow state ───────────────────────────────────────────────────

interface InviteRedemptionState {
  assistantId: string;
  fromNumber: string;
  inviteeName: string | null;
  /** Setup-time trust, used when post-activation re-resolution fails. */
  fallbackTrustContext: TrustContext;
}

// ── Flow ─────────────────────────────────────────────────────────────

export class CallSetupFlow implements SetupFlowInput {
  private state: SetupFlowState = "idle";

  // ── Invite-redemption sub-flow state ────────────────────────────────
  /** Shared digit buffer for code collection (DTMF + spoken digits). */
  private digitBuffer = "";
  /**
   * In-flight dedupe guard: the gateway claim is async, and a repeated
   * code (re-spoken / re-entered) arriving while it is pending must not
   * fire a second redemption that would see the invite already consumed
   * and wrongly fail the call. Set synchronously before awaiting and
   * cleared in a finally.
   */
  private inviteRedemptionInFlight = false;
  private invite: InviteRedemptionState | null = null;

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
    if (this.state === "collecting_code" && this.invite) {
      this.digitBuffer += digit;
      if (this.digitBuffer.length >= INVITE_CODE_LENGTH) {
        const enteredCode = this.digitBuffer.slice(0, INVITE_CODE_LENGTH);
        this.digitBuffer = "";
        void this.handleInviteCodeEntry(enteredCode);
      }
    }
  }

  /** Feed a final caller transcript to the active sub-flow. No-op while idle/completed. */
  pushTranscriptFinal(text: string): void {
    if (!this.acceptsInput()) {
      return;
    }
    if (this.state === "collecting_code" && this.invite) {
      const spokenDigits = parseDigitsFromSpeech(text);
      if (spokenDigits.length >= INVITE_CODE_LENGTH) {
        void this.handleInviteCodeEntry(
          spokenDigits.slice(0, INVITE_CODE_LENGTH),
        );
      } else if (spokenDigits.length > 0) {
        void this.deps.speakSystemPrompt(
          this.transport,
          `I heard ${spokenDigits.length} digits. Please enter all ${INVITE_CODE_LENGTH} digits of your code.`,
        );
      }
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
    // Let the spoken denial play out before tearing down the session.
    setTimeout(
      () => this.transport.endSession(outcome.logReason),
      this.deps.ttsPlaybackDelayMs ?? getTtsPlaybackDelayMs(),
    );
    this.complete({ kind: "ended", reason: outcome.logReason });
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
    this.invite = {
      assistantId: outcome.assistantId,
      fromNumber: outcome.fromNumber,
      inviteeName: outcome.inviteeName,
      fallbackTrustContext: toTrustContext(
        resolved.actorTrust,
        resolved.otherPartyNumber,
      ),
    };
    this.digitBuffer = "";
    this.inviteRedemptionInFlight = false;
    this.state = "collecting_code";

    this.deps.recordCallEvent(this.callSessionId, "invite_redemption_started", {
      assistantId: outcome.assistantId,
      codeLength: INVITE_CODE_LENGTH,
      maxAttempts: 1,
    });

    const displayFriend = firstToken(outcome.inviteeName) ?? "there";
    const displayGuardian = this.deps.resolveGuardianLabel();

    let promptText: string;
    if (!resolved.isInbound) {
      const assistantName = this.deps.resolveAssistantLabel();
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
    if (!invite) {
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
      await this.runInviteCodeRedemption(invite, enteredCode);
    } finally {
      this.inviteRedemptionInFlight = false;
    }
  }

  private async runInviteCodeRedemption(
    invite: InviteRedemptionState,
    enteredCode: string,
  ): Promise<void> {
    const result = await this.deps.attemptInviteCodeRedemption({
      inviteRedemptionFromNumber: invite.fromNumber,
      enteredCode,
      guardianLabel: this.deps.resolveGuardianLabel(),
    });

    if (result.outcome === "success") {
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

      await this.completeInviteActivation(invite);
    } else {
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

      const failSession = this.deps.getCallSession(this.callSessionId);
      if (failSession) {
        this.deps.finalizeCall(this.callSessionId, failSession.conversationId);
      }

      await this.deps.speakSystemPrompt(this.transport, result.ttsMessage);
      setTimeout(
        () => this.transport.endSession("Invite redemption failed"),
        this.deps.ttsPlaybackDelayMs ?? getTtsPlaybackDelayMs(),
      );
      this.complete({ kind: "ended", reason: "Invite redemption failed" });
    }
  }

  /**
   * Post-redemption trusted-contact activation: mark the session live,
   * re-resolve the caller's (now upgraded) trust, speak the personalized
   * handoff copy, and hand control back with `proceed-handoff-spoken`.
   *
   * Greeting rules: only the first whitespace-delimited token of the
   * invitee name is used; an empty/blank name triggers the neutral
   * "Hi there" copy rather than substituting the channel address.
   */
  private async completeInviteActivation(
    invite: InviteRedemptionState,
  ): Promise<void> {
    this.deps.updateCallSession(this.callSessionId, { status: "in_progress" });

    let trustContext: TrustContext;
    try {
      trustContext = await this.deps.resolveMidCallTrustContext(
        invite.assistantId,
        invite.fromNumber,
      );
    } catch (err) {
      log.warn(
        { callSessionId: this.callSessionId, err },
        "Post-redemption trust re-resolution failed — using setup-time trust",
      );
      trustContext = invite.fallbackTrustContext;
    }

    const guardianLabel = this.deps.resolveGuardianLabel();
    const assistantName = this.deps.resolveAssistantLabel();
    const firstName = firstToken(invite.inviteeName);

    let handoffText: string;
    if (firstName) {
      handoffText = assistantName
        ? `Great, I've verified that you are ${firstName}. It's nice to meet you! I'm ${assistantName}, ${guardianLabel}'s assistant. How can I help?`
        : `Great, I've verified that you are ${firstName}. It's nice to meet you! How can I help?`;
    } else {
      handoffText = assistantName
        ? `Hi there! I'm ${assistantName}, ${guardianLabel}'s assistant. How can I help?`
        : `Hi there! How can I help?`;
    }

    void this.deps.speakSystemPrompt(this.transport, handoffText);

    this.deps.recordCallEvent(this.callSessionId, "assistant_spoke", {
      text: handoffText,
    });
    const session = this.deps.getCallSession(this.callSessionId);
    if (session) {
      this.deps.fireCallTranscriptNotifier(
        session.conversationId,
        this.callSessionId,
        "assistant",
        handoffText,
      );
    }

    this.complete({
      kind: "proceed-handoff-spoken",
      assistantId: invite.assistantId,
      trustContext,
    });
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
