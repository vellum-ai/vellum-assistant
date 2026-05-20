/**
 * Zustand store for the chat stream's network/state lifecycle.
 *
 * Codifies what was previously an implicit state machine spread across
 * `use-event-stream.ts`, `use-message-reconciliation.ts`, and
 * `use-stream-event-handler.ts` — together with the four shared refs
 * (`streamRef`, `streamEpochRef`, `streamContextRef`,
 * `reconcileAfterNextStreamOpenRef`) those hooks mutated in undocumented
 * order. One store; one phase; explicit transitions.
 *
 * Phases:
 *
 * - `closed`     — no stream, no fetch in flight, no intent to reopen
 * - `opening`    — open fetch is in flight
 * - `open`       — stream is established and receiving events
 * - `waiting`    — stream is torn down pending an app-lifecycle resume
 *                  (page hidden, app backgrounded, network offline)
 * - `reconciling`— a reconcile fetch must complete before the next open
 *                  (precursor to reopen; ordering enforced by the reducer)
 * - `retrying`   — last open or reconcile failed; awaiting a reachability
 *                  signal or a manual retry before re-attempting
 *
 * Domain events match the [Flux-inspired
 * practice](https://zustand.docs.pmnd.rs/learn/guides/flux-inspired-practice)
 * naming convention from `turn-store.ts`: `on*` for system/SSE reactions,
 * imperative for user/system-initiated transitions. The store exposes
 * direct named actions per CONVENTIONS.md — no dispatcher. A pure
 * `streamLifecycleReducer` is exported alongside for unit-testable state
 * transitions; tests exercise the reducer, not the store.
 *
 * Wrapped with `createSelectors` so consumers read with atomic
 * `useStreamLifecycleStore.use.phase()` selectors; non-React code reads
 * synchronously via `useStreamLifecycleStore.getState()`.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/learn/guides/flux-inspired-practice}
 * @see {@link https://zustand.docs.pmnd.rs/learn/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type StreamLifecyclePhase =
  | "closed"
  | "opening"
  | "open"
  | "waiting"
  | "reconciling"
  | "retrying";

export interface StreamContext {
  assistantId: string;
  conversationKey: string;
}

export interface StreamLifecycleState {
  phase: StreamLifecyclePhase;
  /**
   * Monotonic counter bumped on every transition that starts a new open
   * attempt (`closed | waiting | retrying | reconciling | open(diff-ctx) →
   * opening`). Replaces the old `streamEpochRef` — stream callbacks tag
   * themselves with the epoch at open time and the reducer ignores
   * `OPEN_SUCCESS` / `OPEN_FAILURE` events whose epoch is stale.
   */
  epoch: number;
  /**
   * Number of consecutive open or reconcile failures. Resets to zero on
   * `OPEN_SUCCESS`. Replaces the burst-limiter in `use-event-stream.ts`
   * — the hook layer reads this to compute backoff; the reducer only
   * tracks the counter.
   */
  consecutiveFailures: number;
  /**
   * Identity of the conversation the stream is (or was last) bound to.
   * Cleared on `CLOSE_REQUEST`. Used by the hook to decide whether an
   * inbound `OPEN_REQUEST` is a conversation switch (different context)
   * or a redundant re-open (same context).
   */
  context: StreamContext | null;
  /** Last error message reported via `OPEN_FAILURE` or `RECONCILE_FAILURE`. */
  lastError: string | null;
}

export const INITIAL_STREAM_LIFECYCLE_STATE: StreamLifecycleState = {
  phase: "closed",
  epoch: 0,
  consecutiveFailures: 0,
  context: null,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** True when the lifecycle holds an established stream. */
export function isStreamOpen(state: StreamLifecycleState): boolean {
  return state.phase === "open";
}

/** True when an open attempt is currently in flight. */
export function isStreamConnecting(state: StreamLifecycleState): boolean {
  return state.phase === "opening" || state.phase === "reconciling";
}

/** True when the lifecycle is paused awaiting external resumption. */
export function isStreamPaused(state: StreamLifecycleState): boolean {
  return state.phase === "waiting" || state.phase === "retrying";
}

// ---------------------------------------------------------------------------
// Domain events (pure reducer input — used by tests)
// ---------------------------------------------------------------------------

export interface OpenRequest {
  type: "OPEN_REQUEST";
  context: StreamContext;
}

export interface OpenSuccess {
  type: "OPEN_SUCCESS";
  epoch: number;
}

export interface OpenFailure {
  type: "OPEN_FAILURE";
  epoch: number;
  message: string;
}

export interface ReconcileRequest {
  type: "RECONCILE_REQUEST";
}

export interface ReconcileSuccess {
  type: "RECONCILE_SUCCESS";
}

export interface ReconcileFailure {
  type: "RECONCILE_FAILURE";
  message: string;
}

export interface CloseRequest {
  type: "CLOSE_REQUEST";
  source: "unmount" | "deps_changed" | "lifecycle";
}

export type AppLifecycleSource = "visibility" | "app_state" | "reachability";

export interface AppLifecycleChange {
  type: "APP_LIFECYCLE_CHANGE";
  source: AppLifecycleSource;
  online: boolean;
}

export type DomainEvent =
  | OpenRequest
  | OpenSuccess
  | OpenFailure
  | ReconcileRequest
  | ReconcileSuccess
  | ReconcileFailure
  | CloseRequest
  | AppLifecycleChange;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function sameContext(
  a: StreamContext | null,
  b: StreamContext | null,
): boolean {
  if (!a || !b) return false;
  return (
    a.assistantId === b.assistantId &&
    a.conversationKey === b.conversationKey
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface StreamLifecycleActions {
  /** User/system requests opening the stream for a given conversation. */
  requestOpen: (context: StreamContext) => void;
  /** Stream open fetch resolved successfully for the given epoch. */
  onOpenSuccess: (epoch: number) => void;
  /** Stream open fetch (or active stream) failed for the given epoch. */
  onOpenFailure: (epoch: number, message: string) => void;
  /** Trigger a reconcile that must complete before the next open. */
  requestReconcile: () => void;
  /** Reconcile fetch completed successfully. */
  onReconcileSuccess: () => void;
  /** Reconcile fetch failed. */
  onReconcileFailure: (message: string) => void;
  /** User/system requests tearing the stream down. */
  requestClose: (source: CloseRequest["source"]) => void;
  /** Visibility / app-state / reachability signal. Reducer dedups by phase. */
  onAppLifecycleChange: (
    source: AppLifecycleSource,
    online: boolean,
  ) => void;
}

export type StreamLifecycleStore = StreamLifecycleState & StreamLifecycleActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useStreamLifecycleStoreBase = create<StreamLifecycleStore>()((set) => ({
  ...INITIAL_STREAM_LIFECYCLE_STATE,

  // ----- Open flow -----

  requestOpen: (context) =>
    set((s) => {
      // Dedup: an OPEN_REQUEST for the same context while already
      // opening or open is a no-op. Different context (conversation
      // switch) bumps the epoch and restarts the open.
      if (
        (s.phase === "opening" || s.phase === "open") &&
        sameContext(s.context, context)
      ) {
        return s;
      }
      return {
        phase: "opening" as const,
        epoch: s.epoch + 1,
        context,
        lastError: null,
      };
    }),

  onOpenSuccess: (epoch) =>
    set((s) => {
      // Stale callback from a prior open attempt — ignore. The current
      // attempt's success will arrive separately.
      if (epoch !== s.epoch) return s;
      if (s.phase !== "opening") return s;
      return {
        phase: "open" as const,
        consecutiveFailures: 0,
        lastError: null,
      };
    }),

  onOpenFailure: (epoch, message) =>
    set((s) => {
      if (epoch !== s.epoch) return s;
      // Failures can arrive while opening (fetch rejected) or while
      // open (stream errored mid-flight). Both transition to retrying.
      if (s.phase !== "opening" && s.phase !== "open") return s;
      return {
        phase: "retrying" as const,
        consecutiveFailures: s.consecutiveFailures + 1,
        lastError: message,
      };
    }),

  // ----- Reconcile flow -----

  requestReconcile: () =>
    set((s) => {
      // Reconcile is a precursor to reopen. Valid from any phase that
      // could hold pending local edits or expect to reopen soon. From
      // `closed` it's a no-op (nothing to reconcile against and nothing
      // pending to reopen).
      if (s.phase === "closed" || s.phase === "reconciling") return s;
      return { phase: "reconciling" as const };
    }),

  onReconcileSuccess: () =>
    set((s) => {
      if (s.phase !== "reconciling") return s;
      // Reconcile completed; reopen with a fresh epoch so callbacks
      // from any stale in-flight stream are discarded.
      return {
        phase: "opening" as const,
        epoch: s.epoch + 1,
        lastError: null,
      };
    }),

  onReconcileFailure: (message) =>
    set((s) => {
      if (s.phase !== "reconciling") return s;
      return {
        phase: "retrying" as const,
        consecutiveFailures: s.consecutiveFailures + 1,
        lastError: message,
      };
    }),

  // ----- Close -----

  requestClose: (_source) =>
    set({
      phase: "closed",
      context: null,
    }),

  // ----- App lifecycle (visibility, app state, reachability) -----

  onAppLifecycleChange: (_source, online) =>
    set((s) => {
      if (!online) {
        // Going offline / backgrounded: only `open` and `opening`
        // have something to tear down. Already-paused phases ignore.
        if (s.phase === "open") return { phase: "waiting" as const };
        if (s.phase === "opening") {
          // Abort the in-flight open by bumping epoch so callbacks
          // become stale, and park in `waiting` to resume later.
          return {
            phase: "waiting" as const,
            epoch: s.epoch + 1,
          };
        }
        return s;
      }
      // Coming online / foregrounded: resume from paused phases by
      // running a reconcile first (the state machine enforces order —
      // see CLAUDE.md / `use-event-stream.ts` original behavior). From
      // `closed` we wait for an explicit `requestOpen` from the hook.
      if (s.phase === "waiting" || s.phase === "retrying") {
        return { phase: "reconciling" as const };
      }
      return s;
    }),
}));

export const useStreamLifecycleStore = createSelectors(
  useStreamLifecycleStoreBase,
);

// ---------------------------------------------------------------------------
// Pure reducer (used by tests to verify state transitions in isolation)
// ---------------------------------------------------------------------------

export function streamLifecycleReducer(
  state: StreamLifecycleState,
  event: DomainEvent,
): StreamLifecycleState {
  switch (event.type) {
    case "OPEN_REQUEST":
      if (
        (state.phase === "opening" || state.phase === "open") &&
        sameContext(state.context, event.context)
      ) {
        return state;
      }
      return {
        ...state,
        phase: "opening",
        epoch: state.epoch + 1,
        context: event.context,
        lastError: null,
      };

    case "OPEN_SUCCESS":
      if (event.epoch !== state.epoch) return state;
      if (state.phase !== "opening") return state;
      return {
        ...state,
        phase: "open",
        consecutiveFailures: 0,
        lastError: null,
      };

    case "OPEN_FAILURE":
      if (event.epoch !== state.epoch) return state;
      if (state.phase !== "opening" && state.phase !== "open") return state;
      return {
        ...state,
        phase: "retrying",
        consecutiveFailures: state.consecutiveFailures + 1,
        lastError: event.message,
      };

    case "RECONCILE_REQUEST":
      if (state.phase === "closed" || state.phase === "reconciling") {
        return state;
      }
      return { ...state, phase: "reconciling" };

    case "RECONCILE_SUCCESS":
      if (state.phase !== "reconciling") return state;
      return {
        ...state,
        phase: "opening",
        epoch: state.epoch + 1,
        lastError: null,
      };

    case "RECONCILE_FAILURE":
      if (state.phase !== "reconciling") return state;
      return {
        ...state,
        phase: "retrying",
        consecutiveFailures: state.consecutiveFailures + 1,
        lastError: event.message,
      };

    case "CLOSE_REQUEST":
      return {
        ...state,
        phase: "closed",
        context: null,
      };

    case "APP_LIFECYCLE_CHANGE":
      if (!event.online) {
        if (state.phase === "open") {
          return { ...state, phase: "waiting" };
        }
        if (state.phase === "opening") {
          return { ...state, phase: "waiting", epoch: state.epoch + 1 };
        }
        return state;
      }
      if (state.phase === "waiting" || state.phase === "retrying") {
        return { ...state, phase: "reconciling" };
      }
      return state;
  }
}
