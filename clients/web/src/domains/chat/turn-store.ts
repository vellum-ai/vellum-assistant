/**
 * Zustand store for the turn-level state machine.
 *
 * Owns sending/thinking/streaming lifecycle, queue depth, active tool-call
 * count, and current turn identity. Direct named actions call `set()` to
 * apply pure transitions so render decisions can be derived deterministically.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 * Selector-based subscriptions let each consumer re-render only when its
 * slice changes — critical during streaming where state updates at ~50 ms
 * cadence. Non-React code (stream handlers, reconciliation) reads the
 * latest state synchronously via `useTurnStore.getState()`.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/learn/guides/flux-inspired-practice}
 * @see {@link https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import type { ToolActivityMetadata } from "@/assistant/web-activity-types";
import { createSelectors } from "@/utils/create-selectors";

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
   *  `onActivityThinking` and cleared on terminal transitions. */
  statusText: string | null;
  /**
   * Per-tool-call structured activity metadata (e.g. web_search,
   * web_fetch) received via `tool_result` events during the active turn.
   * Keyed by `toolUseId`. Live-only — cleared on every terminal transition
   * so historical reopens fall back to the persisted
   * `ChatMessageToolCall.activityMetadata` instead. Drives the
   * unified tool-call card selector hook (`useToolCallCardData`).
   */
  liveWebActivity: Record<string, ToolActivityMetadata>;
}

export const INITIAL_TURN_STATE: TurnState = {
  phase: "idle",
  pendingQueuedCount: 0,
  activeToolCallCount: 0,
  activeTurnId: null,
  lastTerminalReason: null,
  statusText: null,
  liveWebActivity: {},
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** True when the turn is actively processing (not idle/errored). */
export function isSending(phase: TurnPhase): boolean {
  return (
    phase === "queued" ||
    phase === "thinking" ||
    phase === "streaming" ||
    phase === "awaiting_user_input"
  );
}

/** True when we are waiting for the first assistant text delta. */
export function isThinking(phase: TurnPhase): boolean {
  return phase === "thinking";
}

// ---------------------------------------------------------------------------
// Domain events (pure reducer input — used by tests)
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

export interface ToolActivityMetadataEvent {
  type: "TOOL_ACTIVITY_METADATA";
  toolUseId: string;
  metadata: ToolActivityMetadata;
}

export interface ActivityStateThinking {
  type: "ACTIVITY_STATE_THINKING";
  statusText?: string;
  /** Mirrors `onActivityThinking`'s `canStartFromIdle` option. */
  canStartFromIdle?: boolean;
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
  turnId?: string;
}

export interface TurnTimeout {
  type: "TURN_TIMEOUT";
}

export interface StaleTurnCleared {
  type: "STALE_TURN_CLEARED";
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
  | ToolActivityMetadataEvent
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
  | StaleTurnCleared
  | MessageQueued
  | MessageDequeued
  | MessageQueuedDeleted;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface TurnActions {
  requestSend: (turnId?: string) => void;
  acceptSend: (turnId: string) => void;
  onTextDelta: () => void;
  onToolUseStart: () => void;
  onToolResult: () => void;
  onToolActivityMetadata: (
    toolUseId: string,
    metadata: ToolActivityMetadata,
  ) => void;
  onActivityThinking: (
    statusText?: string,
    opts?: {
      /** Allow the thinking signal to START activity from an idle turn
       *  store. Set by the stream handler only when the event belongs to
       *  the ACTIVE conversation — daemon-initiated work (e.g. summarize
       *  up to here) reports thinking without a client-initiated turn. */
      canStartFromIdle?: boolean;
    },
  ) => void;
  showSurface: (interactive?: boolean) => void;
  updateSurface: () => void;
  dismissSurface: () => void;
  completeSurface: () => void;
  onSecretRequest: () => void;
  onConfirmationRequest: () => void;
  onQuestionRequest: () => void;
  onContactRequest: () => void;
  completeTurn: () => void;
  handoffGeneration: () => void;
  cancelGeneration: () => void;
  onStreamError: () => void;
  onSessionError: () => void;
  onPollReconciled: (turnId?: string) => void;
  onTurnTimeout: () => void;
  resetTurn: () => void;
  clearStaleTurn: () => void;
  enqueueMessage: () => void;
  dequeueMessage: () => void;
  deleteQueuedMessage: () => void;
}

export type TurnStore = TurnState & TurnActions;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True when no turn is in progress — stale events should be discarded. */
function isStale(s: TurnState): boolean {
  return (s.phase === "idle" || s.phase === "errored") && !s.activeTurnId;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useTurnStoreBase = create<TurnStore>()((set, get) => ({
  ...INITIAL_TURN_STATE,

  // ----- Send flow -----

  requestSend: (turnId) =>
    set((s) => ({
      phase: "thinking" as const,
      activeTurnId: turnId ?? s.activeTurnId,
      lastTerminalReason: null,
      activeToolCallCount: 0,
      statusText: null,
    })),

  acceptSend: (turnId) =>
    set((s) => {
      // The send POST has resolved — we are now waiting for the first
      // assistant text delta. Phase must be "thinking" for that window
      // (see `isThinking` doc comment). If a stale terminal event from
      // a previous turn slipped in between `requestSend` and here during
      // the POST await, phase was clobbered to "idle"/"errored" with
      // `lastTerminalReason` populated. Restore the in-flight shape so
      // the thinking indicator stays visible until the first delta.
      const phaseIsTerminal = s.phase === "idle" || s.phase === "errored";
      return {
        activeTurnId: turnId,
        ...(phaseIsTerminal
          ? { phase: "thinking" as const, lastTerminalReason: null }
          : null),
      };
    }),

  // ----- Streaming -----

  onTextDelta: () => {
    const s = get();
    // Re-activate from idle/errored only when activeTurnId is set,
    // meaning a turn is genuinely in progress. After terminal events
    // clear activeTurnId, stale deltas are discarded.
    if (s.phase === "idle" || s.phase === "errored") {
      if (!s.activeTurnId) return;
      set({ phase: "streaming" });
      return;
    }
    if (s.phase === "thinking" || s.phase === "queued") {
      set({ phase: "streaming" });
    }
  },

  // ----- Tool calls -----

  onToolUseStart: () => {
    const s = get();
    if (isStale(s)) return;
    set({
      phase:
        s.phase === "idle" || s.phase === "errored" || s.phase === "queued"
          ? "thinking"
          : s.phase,
      activeToolCallCount: s.activeToolCallCount + 1,
    });
  },

  onToolResult: () =>
    set((s) => ({
      activeToolCallCount: Math.max(0, s.activeToolCallCount - 1),
    })),

  onToolActivityMetadata: (toolUseId, metadata) => {
    const s = get();
    // Stale guard: a tool_result for the previous turn may arrive after we
    // already transitioned to idle. Don't repopulate liveWebActivity post
    // terminal — it'll just leak into the next turn's card render.
    if (isStale(s)) return;
    set({
      liveWebActivity: { ...s.liveWebActivity, [toolUseId]: metadata },
    });
  },

  // ----- Daemon activity state -----

  onActivityThinking: (statusText, opts) => {
    const s = get();
    // Server-driven thinking signal — the daemon reports that the agent
    // is processing (e.g. after a tool_result, during context compaction,
    // or after confirmation resolution). Transition back to "thinking"
    // so the thinking indicator re-appears in the post-tool-call gap.
    if (isStale(s)) {
      // No client-initiated turn is active. Daemon-initiated work (e.g.
      // summarize-up-to-here) still reports thinking — accept it only when
      // the handler scoped the event to the active conversation, so a
      // background conversation's activity can't light this tab's
      // indicator. Terminal teardown arrives via the paired idle activity
      // event or the result card's message_complete (both call endTurn).
      if (!opts?.canStartFromIdle) return;
      set({
        phase: "thinking",
        statusText: statusText ?? null,
        lastTerminalReason: null,
      });
      return;
    }
    if (s.phase === "awaiting_user_input") return;
    set({ phase: "thinking", statusText: statusText ?? null });
  },

  // ----- UI surfaces -----

  showSurface: (interactive) => {
    const s = get();
    if (isStale(s)) return;
    // Only transition to awaiting_user_input for interactive surfaces
    // (form, confirmation, file_upload). Non-interactive surfaces (card,
    // table, list) are display-only and shouldn't pause the turn.
    if (!interactive) return;
    set({ phase: "awaiting_user_input" });
  },

  updateSurface: () => {
    // No phase change — surface content update only.
  },

  dismissSurface: () => {
    const s = get();
    // Surface dismissed — if awaiting user input with no outstanding
    // tool calls, transition back to thinking so subsequent events
    // (e.g. completeTurn) can land and the input is re-enabled.
    if (s.phase === "awaiting_user_input" && s.activeToolCallCount === 0) {
      set({ phase: "thinking" });
    }
  },

  completeSurface: () => {
    const s = get();
    // When the surface completes and we were awaiting user input with
    // no outstanding tool calls, transition back to thinking so we can
    // receive the next event (e.g. completeTurn). Without this, the
    // phase stays stuck at awaiting_user_input.
    if (s.phase === "awaiting_user_input" && s.activeToolCallCount === 0) {
      set({ phase: "thinking" });
    }
  },

  // ----- Interruptions (awaiting user input) -----

  onSecretRequest: () => {
    if (isStale(get())) return;
    set({ phase: "awaiting_user_input" });
  },

  onConfirmationRequest: () => {
    if (isStale(get())) return;
    set({ phase: "awaiting_user_input" });
  },

  onQuestionRequest: () => {
    if (isStale(get())) return;
    set({ phase: "awaiting_user_input" });
  },

  onContactRequest: () => {
    if (isStale(get())) return;
    set({ phase: "awaiting_user_input" });
  },

  // ----- Turn completion -----

  completeTurn: () => {
    const s = get();
    // When queued messages remain, transition to "queued" instead of
    // idle so the UI knows the assistant will continue processing.
    set({
      phase: s.pendingQueuedCount > 0 ? "queued" : "idle",
      activeTurnId: null,
      activeToolCallCount: 0,
      lastTerminalReason: "complete",
      statusText: null,
      liveWebActivity: {},
    });
  },

  handoffGeneration: () => {
    if (isStale(get())) return;
    // Current assistant chunk is finalized; more chunks expected.
    set({ phase: "thinking", activeToolCallCount: 0, statusText: null });
  },

  // ----- Terminal / error states -----

  cancelGeneration: () => {
    const s = get();
    set({
      phase: s.pendingQueuedCount > 0 ? "queued" : "idle",
      activeTurnId: null,
      activeToolCallCount: 0,
      lastTerminalReason: "cancelled",
      statusText: null,
      liveWebActivity: {},
    });
  },

  onStreamError: () =>
    set({
      phase: "idle",
      activeTurnId: null,
      activeToolCallCount: 0,
      pendingQueuedCount: 0,
      lastTerminalReason: "error",
      statusText: null,
      liveWebActivity: {},
    }),

  onSessionError: () =>
    set({
      phase: "idle",
      activeTurnId: null,
      activeToolCallCount: 0,
      pendingQueuedCount: 0,
      lastTerminalReason: "session_error",
      statusText: null,
      liveWebActivity: {},
    }),

  onTurnTimeout: () =>
    set({
      phase: "idle",
      activeTurnId: null,
      activeToolCallCount: 0,
      pendingQueuedCount: 0,
      lastTerminalReason: "timeout",
      statusText: null,
      liveWebActivity: {},
    }),

  // ----- Reconciliation -----

  onPollReconciled: (turnId) => {
    const s = get();
    // Authoritative fallback — if SSE missed the terminal event,
    // polling says the turn is done. Only transition if still active.
    // When turnId is provided, only honour if it matches the current
    // turn — makes completion idempotent when SSE and polling race.
    if (turnId && turnId !== s.activeTurnId) return;
    if (!isSending(s.phase)) return;
    set({
      phase: "idle",
      activeTurnId: null,
      activeToolCallCount: 0,
      lastTerminalReason: "complete",
      statusText: null,
      liveWebActivity: {},
    });
  },

  // ----- Hard reset -----

  resetTurn: () => set({ ...INITIAL_TURN_STATE }),

  /**
   * Reset only when no turn is genuinely in flight — for "clean up possibly
   * stale turn UI" callers (the reachability burst-limiter's ready signal)
   * that must NOT clobber a live turn. The initial reachability probe
   * resolves "ready" during a new conversation's first send; a hard reset
   * there nulls `activeTurnId` mid-turn, after which `onTextDelta`'s
   * stale-delta guard refuses to re-activate the phase and the whole first
   * turn renders as phase "idle" (no thinking indicator, no streaming
   * affordances). A live turn that just survived a reconnect needs no reset
   * anyway: the post-reconnect reconcile resyncs its true state.
   */
  clearStaleTurn: () => {
    const s = get();
    if (s.activeTurnId && isSending(s.phase)) return;
    set({ ...INITIAL_TURN_STATE });
  },

  // ----- Queue management -----

  enqueueMessage: () =>
    set((s) => ({ pendingQueuedCount: s.pendingQueuedCount + 1 })),

  dequeueMessage: () => {
    const s = get();
    const nextCount = Math.max(0, s.pendingQueuedCount - 1);
    // Guard: if idle/errored with no activeTurnId this is a stale
    // event — decrement the count but don't re-activate.
    if (isStale(s)) {
      set({ pendingQueuedCount: nextCount });
      return;
    }
    set({ phase: "thinking", pendingQueuedCount: nextCount });
  },

  deleteQueuedMessage: () => {
    const s = get();
    const nextCount = Math.max(0, s.pendingQueuedCount - 1);
    if (nextCount === 0 && s.phase === "queued") {
      set({
        phase: "idle",
        pendingQueuedCount: 0,
        activeTurnId: null,
        lastTerminalReason: "complete",
        statusText: null,
        liveWebActivity: {},
      });
      return;
    }
    set({ pendingQueuedCount: nextCount });
  },
}));

export const useTurnStore = createSelectors(useTurnStoreBase);

// ---------------------------------------------------------------------------
// Pure reducer (used by tests to verify state transitions in isolation)
// ---------------------------------------------------------------------------

export function turnReducer(state: TurnState, event: DomainEvent): TurnState {
  switch (event.type) {
    case "USER_SEND_REQUESTED":
      return {
        ...state,
        phase: "thinking",
        activeTurnId: event.turnId ?? state.activeTurnId,
        lastTerminalReason: null,
        activeToolCallCount: 0,
        statusText: null,
      };

    case "USER_SEND_ACCEPTED": {
      // See `acceptSend` action for rationale.
      const phaseIsTerminal =
        state.phase === "idle" || state.phase === "errored";
      return {
        ...state,
        activeTurnId: event.turnId,
        ...(phaseIsTerminal
          ? { phase: "thinking" as const, lastTerminalReason: null }
          : null),
      };
    }

    case "ASSISTANT_TEXT_DELTA":
      if (state.phase === "idle" || state.phase === "errored") {
        if (!state.activeTurnId) return state;
        return { ...state, phase: "streaming" };
      }
      if (state.phase === "thinking" || state.phase === "queued") {
        return { ...state, phase: "streaming" };
      }
      return state;

    case "TOOL_USE_START":
      if (isStale(state)) return state;
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

    case "TOOL_ACTIVITY_METADATA":
      if (isStale(state)) return state;
      return {
        ...state,
        liveWebActivity: {
          ...state.liveWebActivity,
          [event.toolUseId]: event.metadata,
        },
      };

    case "ACTIVITY_STATE_THINKING":
      if (isStale(state)) {
        // Daemon-initiated activity (e.g. summarize-up-to-here) may start
        // without a client-initiated turn — mirrors `onActivityThinking`.
        if (!event.canStartFromIdle) return state;
        return {
          ...state,
          phase: "thinking",
          statusText: event.statusText ?? null,
          lastTerminalReason: null,
        };
      }
      if (state.phase === "awaiting_user_input") return state;
      return {
        ...state,
        phase: "thinking",
        statusText: event.statusText ?? null,
      };

    case "UI_SURFACE_SHOW":
      if (isStale(state)) return state;
      if (!event.interactive) return state;
      return { ...state, phase: "awaiting_user_input" };

    case "UI_SURFACE_UPDATE":
      return state;

    case "UI_SURFACE_DISMISS":
      if (
        state.phase === "awaiting_user_input" &&
        state.activeToolCallCount === 0
      ) {
        return { ...state, phase: "thinking" };
      }
      return state;

    case "UI_SURFACE_COMPLETE":
      if (
        state.phase === "awaiting_user_input" &&
        state.activeToolCallCount === 0
      ) {
        return { ...state, phase: "thinking" };
      }
      return state;

    case "SECRET_REQUEST":
    case "CONFIRMATION_REQUEST":
    case "QUESTION_REQUEST":
    case "CONTACT_REQUEST":
      if (isStale(state)) return state;
      return { ...state, phase: "awaiting_user_input" };

    case "MESSAGE_QUEUED":
      return {
        ...state,
        pendingQueuedCount: state.pendingQueuedCount + 1,
      };

    case "MESSAGE_DEQUEUED":
      if (isStale(state)) {
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
          liveWebActivity: {},
        };
      }
      return { ...state, pendingQueuedCount: nextCount };
    }

    case "MESSAGE_COMPLETE":
      if (state.pendingQueuedCount > 0) {
        return {
          ...state,
          phase: "queued",
          activeTurnId: null,
          activeToolCallCount: 0,
          lastTerminalReason: "complete",
          statusText: null,
          liveWebActivity: {},
        };
      }
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        lastTerminalReason: "complete",
        statusText: null,
        liveWebActivity: {},
      };

    case "GENERATION_HANDOFF":
      return {
        ...state,
        phase: "thinking",
        activeToolCallCount: 0,
        statusText: null,
      };

    case "GENERATION_CANCELLED":
      if (state.pendingQueuedCount > 0) {
        return {
          ...state,
          phase: "queued",
          activeTurnId: null,
          activeToolCallCount: 0,
          lastTerminalReason: "cancelled",
          statusText: null,
          liveWebActivity: {},
        };
      }
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        lastTerminalReason: "cancelled",
        statusText: null,
        liveWebActivity: {},
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
        liveWebActivity: {},
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
        liveWebActivity: {},
      };

    case "POLL_RECONCILED": {
      if (!isSending(state.phase)) return state;
      if (
        event.turnId &&
        state.activeTurnId &&
        event.turnId !== state.activeTurnId
      ) {
        return state;
      }
      if (state.pendingQueuedCount > 0) {
        return {
          ...state,
          phase: "queued",
          activeTurnId: null,
          activeToolCallCount: 0,
          lastTerminalReason: "complete",
          statusText: null,
          liveWebActivity: {},
        };
      }
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        lastTerminalReason: "complete",
        statusText: null,
        liveWebActivity: {},
      };
    }

    case "TURN_TIMEOUT":
      return {
        ...state,
        phase: "idle",
        activeTurnId: null,
        activeToolCallCount: 0,
        pendingQueuedCount: 0,
        lastTerminalReason: "timeout",
        statusText: null,
        liveWebActivity: {},
      };

    case "TURN_RESET":
      return { ...INITIAL_TURN_STATE };

    case "STALE_TURN_CLEARED":
      // See `clearStaleTurn` action for rationale.
      if (state.activeTurnId && isSending(state.phase)) return state;
      return { ...INITIAL_TURN_STATE };
  }
}
