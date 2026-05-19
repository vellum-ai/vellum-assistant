/**
 * Turn-level state machine for the assistant chat.
 *
 * Owns sending/thinking/streaming lifecycle, queue depth, active tool-call
 * count, and current turn identity.  Accepts typed domain events and applies
 * pure transitions so render decisions can be derived deterministically.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type TurnPhase =
  | "idle"
  | "queued"
  | "thinking"
  | "streaming"
  | "awaiting_user_input"
  | "errored";

export type TerminalReason =
  | "complete"
  | "error"
  | "cancelled"
  | "timeout"
  | "session_error"
  | null;

export interface TurnState {
  phase: TurnPhase;
  pendingQueuedCount: number;
  activeToolCallCount: number;
  activeTurnId: string | null;
  lastTerminalReason: TerminalReason;
  /** Daemon-provided label describing current agent activity (e.g.
   *  "Processing bash results", "Compacting context"). Populated by
   *  `ACTIVITY_STATE_THINKING` and cleared on terminal transitions. */
  statusText: string | null;
}

export const INITIAL_TURN_STATE: TurnState = {
  phase: "idle",
  pendingQueuedCount: 0,
  activeToolCallCount: 0,
  activeTurnId: null,
  lastTerminalReason: null,
  statusText: null,
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** True when the turn is actively processing (not idle/errored). */
export function isSending(state: TurnState): boolean {
  return (
    state.phase === "queued" ||
    state.phase === "thinking" ||
    state.phase === "streaming" ||
    state.phase === "awaiting_user_input"
  );
}

/** True when we are waiting for the first assistant text delta. */
export function isThinking(state: TurnState): boolean {
  return state.phase === "thinking";
}

// ---------------------------------------------------------------------------
// Domain events
// ---------------------------------------------------------------------------

export interface UserSendRequested {
  type: "USER_SEND_REQUESTED";
  turnId?: string;
}

export interface UserSendAccepted {
  type: "USER_SEND_ACCEPTED";
  turnId: string;
}

export interface AssistantTextDelta {
  type: "ASSISTANT_TEXT_DELTA";
}

export interface ToolUseStart {
  type: "TOOL_USE_START";
}

export interface ToolResult {
  type: "TOOL_RESULT";
}

export interface ActivityStateThinking {
  type: "ACTIVITY_STATE_THINKING";
  statusText?: string;
}

export interface UISurfaceShow {
  type: "UI_SURFACE_SHOW";
  interactive?: boolean;
}

export interface UISurfaceUpdate {
  type: "UI_SURFACE_UPDATE";
}

export interface UISurfaceDismiss {
  type: "UI_SURFACE_DISMISS";
}

export interface UISurfaceComplete {
  type: "UI_SURFACE_COMPLETE";
}

export interface SecretRequest {
  type: "SECRET_REQUEST";
}

export interface ConfirmationRequest {
  type: "CONFIRMATION_REQUEST";
}

export interface QuestionRequest {
  type: "QUESTION_REQUEST";
}

export interface ContactRequest {
  type: "CONTACT_REQUEST";
}

export interface MessageComplete {
  type: "MESSAGE_COMPLETE";
}

export interface GenerationHandoff {
  type: "GENERATION_HANDOFF";
}

export interface GenerationCancelled {
  type: "GENERATION_CANCELLED";
}

export interface StreamError {
  type: "STREAM_ERROR";
}

export interface SessionError {
  type: "SESSION_ERROR";
}

export interface PollReconciled {
  type: "POLL_RECONCILED";
  /** The turn this reconciliation belongs to.  When provided, the reducer
   *  will only transition if `activeTurnId` matches — making completion
   *  idempotent when SSE and polling race. */
  turnId?: string;
}

export interface TurnTimeout {
  type: "TURN_TIMEOUT";
}

export interface TurnReset {
  type: "TURN_RESET";
}

export interface MessageQueued {
  type: "MESSAGE_QUEUED";
}

export interface MessageDequeued {
  type: "MESSAGE_DEQUEUED";
}

export interface MessageQueuedDeleted {
  type: "MESSAGE_QUEUED_DELETED";
}

export type DomainEvent =
  | UserSendRequested
  | UserSendAccepted
  | AssistantTextDelta
  | ToolUseStart
  | ToolResult
  | ActivityStateThinking
  | UISurfaceShow
  | UISurfaceUpdate
  | UISurfaceDismiss
  | UISurfaceComplete
  | SecretRequest
  | ConfirmationRequest
  | QuestionRequest
  | ContactRequest
  | MessageComplete
  | GenerationHandoff
  | GenerationCancelled
  | StreamError
  | SessionError
  | PollReconciled
  | TurnTimeout
  | TurnReset
  | MessageQueued
  | MessageDequeued
  | MessageQueuedDeleted;

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function turnReducer(state: TurnState, event: DomainEvent): TurnState {
  switch (event.type) {
    // ----- Send flow -----
    case "USER_SEND_REQUESTED":
      return {
        ...state,
        phase: "thinking",
        activeTurnId: event.turnId ?? state.activeTurnId,
        lastTerminalReason: null,
        activeToolCallCount: 0,
        statusText: null,
      };

    case "USER_SEND_ACCEPTED":
      return {
        ...state,
        activeTurnId: event.turnId,
        // Stay in current phase (thinking) — the accepted event just
        // confirms identity.
      };

    // ----- Streaming -----
    case "ASSISTANT_TEXT_DELTA":
      // Only re-activate from idle/errored when activeTurnId is set,
      // meaning a turn is genuinely in progress. After terminal
      // events clear activeTurnId, stale deltas are discarded.
      if (state.phase === "idle" || state.phase === "errored") {
        if (!state.activeTurnId) return state;
        return { ...state, phase: "streaming" };
      }
      if (state.phase === "thinking" || state.phase === "queued") {
        return { ...state, phase: "streaming" };
      }
      return state;

    // ----- Tool calls -----
    case "TOOL_USE_START":
      // Discard when no turn is in progress (same guard as text deltas).
      if (
        (state.phase === "idle" || state.phase === "errored") &&
        !state.activeTurnId
      ) {
        return state;
      }
      return {
        ...state,
        phase:
          state.phase === "idle" || state.phase === "errored"
            ? "thinking"
            : state.phase === "queued"
              ? "thinking"
              : state.phase,
        activeToolCallCount: state.activeToolCallCount + 1,
      };

    case "TOOL_RESULT":
      return {
        ...state,
        activeToolCallCount: Math.max(0, state.activeToolCallCount - 1),
      };

    // ----- Daemon activity state -----
    case "ACTIVITY_STATE_THINKING":
      // Server-driven thinking signal — the daemon reports that the agent
      // is processing (e.g. after a tool_result, during context compaction,
      // or after confirmation resolution). Transition back to "thinking"
      // so the thinking indicator re-appears in the post-tool-call gap
      // that no dedicated SSE event covers.
      if (
        (state.phase === "idle" || state.phase === "errored") &&
        !state.activeTurnId
      ) {
        return state;
      }
      if (state.phase === "awaiting_user_input") {
        return state;
      }
      return { ...state, phase: "thinking", statusText: event.statusText ?? null };

    // ----- UI surfaces -----
    case "UI_SURFACE_SHOW":
      if (
        (state.phase === "idle" || state.phase === "errored") &&
        !state.activeTurnId
      ) {
        return state;
      }
      // Only transition to awaiting_user_input for interactive surfaces
      // (form, confirmation, file_upload). Non-interactive surfaces (card,
      // table, list) are display-only and shouldn't pause the turn —
      // otherwise the stop button and processing indicator disappear.
      if (!event.interactive) {
        return state;
      }
      return {
        ...state,
        phase: "awaiting_user_input",
      };

    case "UI_SURFACE_UPDATE":
      // No phase change — surface is still active
      return state;

    case "UI_SURFACE_DISMISS":
      // Surface dismissed — same logic as UI_SURFACE_COMPLETE: if we
      // were awaiting user input with no outstanding tool calls,
      // transition back to thinking so subsequent events (e.g.
      // MESSAGE_COMPLETE) can land and the input is re-enabled.
      if (
        state.phase === "awaiting_user_input" &&
        state.activeToolCallCount === 0
      ) {
        return { ...state, phase: "thinking" };
      }
      return state;

    case "UI_SURFACE_COMPLETE":
      // When the surface completes and we were awaiting user input with no
      // outstanding tool calls, transition back to thinking so we can
      // receive the next event (e.g. MESSAGE_COMPLETE).  Without this,
      // the phase stays stuck at awaiting_user_input and isSendDisabled
      // returns true permanently.
      if (
        state.phase === "awaiting_user_input" &&
        state.activeToolCallCount === 0
      ) {
        return { ...state, phase: "thinking" };
      }
      return state;

    // ----- Interruptions (awaiting user input) -----
    case "SECRET_REQUEST":
    case "CONFIRMATION_REQUEST":
    case "QUESTION_REQUEST":
    case "CONTACT_REQUEST":
      if (
        (state.phase === "idle" || state.phase === "errored") &&
        !state.activeTurnId
      ) {
        return state;
      }
      return {
        ...state,
        phase: "awaiting_user_input",
      };

    // ----- Queue management -----
    case "MESSAGE_QUEUED":
      return {
        ...state,
        pendingQueuedCount: state.pendingQueuedCount + 1,
      };

    case "MESSAGE_DEQUEUED":
      // Guard: if idle/errored with no activeTurnId this is a stale
      // event — decrement the count but don't re-activate.
      if (
        (state.phase === "idle" || state.phase === "errored") &&
        !state.activeTurnId
      ) {
        return {
          ...state,
          pendingQueuedCount: Math.max(0, state.pendingQueuedCount - 1),
        };
      }
      return {
        ...state,
        phase: "thinking",
        pendingQueuedCount: Math.max(0, state.pendingQueuedCount - 1),
      };

    case "MESSAGE_QUEUED_DELETED": {
      const nextCount = Math.max(0, state.pendingQueuedCount - 1);
      if (nextCount === 0 && state.phase === "queued") {
        return {
          ...state,
          phase: "idle",
          pendingQueuedCount: 0,
          activeTurnId: null,
          lastTerminalReason: "complete",
          statusText: null,
        };
      }
      return {
        ...state,
        pendingQueuedCount: nextCount,
      };
    }

    // ----- Turn completion -----
    case "MESSAGE_COMPLETE":
      // When queued messages remain, transition to "queued" instead of
      // idle so the UI knows the assistant will continue processing.
      if (state.pendingQueuedCount > 0) {
        return {
          ...state,
          phase: "queued",
          activeTurnId: null,
          activeToolCallCount: 0,
          lastTerminalReason: "complete",
          statusText: null,
        };
      }
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        lastTerminalReason: "complete",
        statusText: null,
      };

    case "GENERATION_HANDOFF":
      // Current assistant chunk is finalized; more chunks expected.
      // Go back to thinking for the next chunk.
      if (
        (state.phase === "idle" || state.phase === "errored") &&
        !state.activeTurnId
      ) {
        return state;
      }
      return {
        ...state,
        phase: "thinking",
        activeToolCallCount: 0,
        statusText: null,
      };

    // ----- Terminal / error states -----
    case "GENERATION_CANCELLED":
      if (state.pendingQueuedCount > 0) {
        return {
          ...state,
          phase: "queued",
          activeTurnId: null,
          activeToolCallCount: 0,
          lastTerminalReason: "cancelled",
          statusText: null,
        };
      }
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        lastTerminalReason: "cancelled",
        statusText: null,
      };

    case "STREAM_ERROR":
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        pendingQueuedCount: 0,
        lastTerminalReason: "error",
        statusText: null,
      };

    case "SESSION_ERROR":
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        pendingQueuedCount: 0,
        lastTerminalReason: "session_error",
        statusText: null,
      };

    case "TURN_TIMEOUT":
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        pendingQueuedCount: 0,
        lastTerminalReason: "timeout",
        statusText: null,
      };

    // ----- Reconciliation -----
    case "POLL_RECONCILED":
      // Authoritative fallback — if SSE missed the terminal event,
      // polling says the turn is done.  Only transition if we are
      // still in an active phase.
      //
      // When a `turnId` is provided, the event is only honoured if it
      // matches the currently-active turn.  This makes completion
      // idempotent: if SSE already finalised the turn (clearing
      // `activeTurnId`), a lagging poll for that same turn becomes a
      // harmless no-op.
      if (event.turnId && event.turnId !== state.activeTurnId) {
        return state;
      }
      if (isSending(state)) {
        return {
          ...state,
          phase: "idle",
          activeTurnId: null,
          activeToolCallCount: 0,
          lastTerminalReason: "complete",
          statusText: null,
        };
      }
      return state;

    // ----- Hard reset -----
    case "TURN_RESET":
      return { ...INITIAL_TURN_STATE };

    default:
      return state;
  }
}
