/**
 * Transport-agnostic interactive call-setup types.
 *
 * These describe the surface of the {@link CallSetupFlow} state machine,
 * which orchestrates the deterministic, pre-conversation setup phase of a
 * call (verification, invite redemption, name capture, etc.) independently
 * of any specific wire transport.
 *
 * The flow is the source of truth for its own wait state via
 * {@link SetupFlowState} — it does **not** infer wait state from
 * `transport.getConnectionState()`. On the media-stream transport that
 * method only reports `connected`/`closed` (see `media-stream-output.ts`
 * `state`), so it cannot distinguish "collecting a DTMF code" from
 * "awaiting a guardian decision". An explicit state surface keeps the
 * controller and tests honest about which sub-flow is active.
 */

import type { TrustContext } from "../daemon/trust-context.js";

// ── Transport ────────────────────────────────────────────────────────

/**
 * The structural subset of {@link import("./call-transport.js").CallTransport}
 * that the setup flow needs to speak prompts and end the session.
 *
 * Deliberately narrower than `CallTransport` so the flow can be driven by
 * any output adapter — including {@link import("./media-stream-output.js").MediaStreamOutput},
 * which satisfies this shape.
 */
export interface SetupFlowTransport {
  /** Send a text token for TTS playback; `last: true` signals end-of-turn. */
  sendTextToken(token: string, last: boolean): void;
  /** End the underlying call session. */
  endSession(reason?: string): void;
  /** Connection-level state (`connected`/`closed` on media-stream). */
  getConnectionState(): string;
  /** When true, the transport requires WAV (PCM) audio for playback. */
  readonly requiresWavAudio?: boolean;
}

// ── Caller input ─────────────────────────────────────────────────────

/**
 * Caller-driven input fed into the active sub-flow. Sub-flows added in
 * later PRs (verification, invite, name capture) consume these; until a
 * sub-flow is active they are no-ops.
 */
export interface SetupFlowInput {
  /** A single DTMF digit pressed by the caller. */
  pushDtmfDigit(digit: string): void;
  /** A finalized speech transcript from the caller. */
  pushTranscriptFinal(text: string): void;
}

// ── Explicit flow state ──────────────────────────────────────────────

/**
 * Explicit setup-flow state. The source of truth for which sub-flow (if
 * any) is awaiting caller input — never inferred from the transport's
 * connection state.
 */
export type SetupFlowState =
  | "idle"
  | "collecting_code"
  | "capturing_name"
  | "awaiting_guardian_decision"
  | "completed";

// ── Result ───────────────────────────────────────────────────────────

/**
 * The continuation the controller should perform once the setup flow has
 * resolved. Mirrors the distinct continuations `relay-server.ts`
 * `handleSetup` performs after routing.
 */
export type SetupFlowResult =
  | {
      /** Normal call — controller fires `startInitialGreeting()`. */
      kind: "proceed-initial-greeting";
      assistantId: string;
      trustContext: TrustContext;
    }
  | {
      /**
       * Outbound verification succeeded — controller fires
       * `startPostVerificationGreeting()`.
       */
      kind: "proceed-post-verification-greeting";
      assistantId: string;
      trustContext: TrustContext;
    }
  | {
      /**
       * A continuation already spoke (e.g. post-approval handoff copy), so
       * the controller should `markNextCallerTurnAsOpeningAck()` rather
       * than greet again.
       */
      kind: "proceed-handoff-spoken";
      assistantId: string;
      trustContext: TrustContext;
    }
  | {
      /** The flow spoke a terminal message and ended the session. */
      kind: "ended";
      reason: string;
    };
