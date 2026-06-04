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

import type { TrustContext } from "../daemon/trust-context.js";
import { toTrustContext } from "../runtime/actor-trust-resolver.js";
import { AssistantError, ErrorCode } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import type {
  SetupFlowInput,
  SetupFlowResult,
  SetupFlowState,
  SetupFlowTransport,
} from "./call-setup-flow-types.js";
import type { SetupOutcome, SetupResolved } from "./relay-setup-router.js";

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
}

// ── Flow ─────────────────────────────────────────────────────────────

export class CallSetupFlow implements SetupFlowInput {
  private state: SetupFlowState = "idle";

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

      default:
        throw new UnsupportedSetupFlowError(outcome.action);
    }
  }

  // ── SetupFlowInput ──────────────────────────────────────────────────
  // No-ops until a sub-flow (verification / name capture) is active; the
  // sub-flows that consume caller input land in later PRs.

  pushDtmfDigit(_digit: string): void {}

  pushTranscriptFinal(_text: string): void {}

  // ── Internal ────────────────────────────────────────────────────────

  /** Speak the denial copy, end the session, and resolve as `ended`. */
  private async handleDeny(
    outcome: Extract<SetupOutcome, { action: "deny" }>,
  ): Promise<SetupFlowResult> {
    this.deps.recordCallEvent(this.callSessionId, "inbound_acl_denied", {
      logReason: outcome.logReason,
    });
    await this.deps.speakSystemPrompt(this.transport, outcome.message);
    this.transport.endSession(outcome.logReason);
    return this.complete({ kind: "ended", reason: outcome.logReason });
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
