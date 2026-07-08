/**
 * Types for the transport-agnostic call setup flow.
 *
 * The setup flow runs the pre-conversation phase of a phone call (ACL
 * denial, verification, invite redemption, name capture) against any
 * transport that can speak and end the session. Its result describes how
 * the owning server should continue the call once setup completes.
 */

import type { TrustContext } from "../daemon/trust-context-types.js";

// ── Transport surface ────────────────────────────────────────────────

/**
 * Structural subset of `CallTransport` (call-transport.ts) that the setup
 * flow needs: speak and end the session. `MediaStreamOutput` satisfies
 * this interface (asserted at compile time in call-setup-flow.test.ts).
 */
export interface SetupFlowTransport {
  sendTextToken(token: string, last: boolean): void;
  endSession(reason?: string): void;
  readonly requiresWavAudio?: boolean;
}

// ── Flow state ───────────────────────────────────────────────────────

/**
 * Explicit setup-flow state. The flow is the sole source of truth for its
 * state — it is never inferred from the transport.
 */
export type SetupFlowState =
  | "idle"
  | "collecting_code"
  | "capturing_name"
  | "awaiting_guardian_decision"
  | "completed";

// ── Terminal results ─────────────────────────────────────────────────

/**
 * Terminal setup-flow result, mirroring the distinct continuations of the
 * relay setup path:
 *
 * - `proceed-initial-greeting` — the controller fires
 *   `startInitialGreeting()`.
 * - `proceed-post-verification-greeting` — the controller fires
 *   `startPostVerificationGreeting()`.
 * - `proceed-handoff-spoken` — the flow already spoke the handoff copy;
 *   the controller calls `markNextCallerTurnAsOpeningAck()`.
 * - `ended` — the flow terminated the call; no controller is created.
 *
 * `deferredTranscripts` carries final caller transcripts that arrived while
 * mid-setup trust re-resolution was in flight. The owning server replays
 * them (in order) into the call controller once it exists, so a verified
 * caller's first utterance is answered under the upgraded trust.
 */
export type SetupFlowResult =
  | {
      kind: "proceed-initial-greeting";
      assistantId: string;
      trustContext: TrustContext;
      deferredTranscripts?: string[];
    }
  | {
      kind: "proceed-post-verification-greeting";
      assistantId: string;
      trustContext: TrustContext;
      deferredTranscripts?: string[];
    }
  | {
      kind: "proceed-handoff-spoken";
      assistantId: string;
      trustContext: TrustContext;
      deferredTranscripts?: string[];
    }
  | { kind: "ended"; reason: string };
