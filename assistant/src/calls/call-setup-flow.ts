/**
 * Transport-agnostic call setup flow.
 *
 * Runs the pre-conversation phase of a phone call — acting on the routing
 * outcome produced by `routeSetup` (relay-setup-router.ts) — against any
 * {@link SetupFlowTransport}. All side effects (speech, call-store writes,
 * completion) flow through injected deps so the flow is unit-testable and
 * independent of any wire protocol.
 *
 * Handles `normal_call` and `deny`. Other setup actions (verification,
 * invite redemption, name capture) throw {@link UnsupportedSetupFlowError}.
 */

import { toTrustContext } from "../runtime/actor-trust-resolver.js";
import { getTtsPlaybackDelayMs } from "./call-constants.js";
import type {
  SetupFlowInput,
  SetupFlowResult,
  SetupFlowState,
  SetupFlowTransport,
} from "./call-setup-flow-types.js";
import type {
  recordCallEvent as recordCallEventFn,
  updateCallSession as updateCallSessionFn,
} from "./call-store.js";
import type { SetupOutcome, SetupResolved } from "./relay-setup-router.js";

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
}

// ── Flow ─────────────────────────────────────────────────────────────

export class CallSetupFlow implements SetupFlowInput {
  private state: SetupFlowState = "idle";

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

      default:
        throw new UnsupportedSetupFlowError(outcome.action);
    }
  }

  // ── SetupFlowInput ──────────────────────────────────────────────────

  /** Feed a DTMF digit to the active sub-flow. No-op while idle/completed. */
  pushDtmfDigit(_digit: string): void {
    if (!this.acceptsInput()) {
      return;
    }
  }

  /** Feed a final caller transcript to the active sub-flow. No-op while idle/completed. */
  pushTranscriptFinal(_text: string): void {
    if (!this.acceptsInput()) {
      return;
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

  // ── Internals ───────────────────────────────────────────────────────

  private acceptsInput(): boolean {
    return this.state !== "idle" && this.state !== "completed";
  }

  private complete(result: SetupFlowResult): void {
    this.state = "completed";
    this.deps.onComplete(result);
  }
}
