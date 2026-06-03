/**
 * Zustand store for SSE stream infrastructure state.
 *
 * Owns the stream presence bit, epoch counter, and stream context
 * (assistantId + conversationId anchor) that were previously held as
 * `useRef` in ChatPage and drilled through ~30 consumer files.
 *
 * All state is imperative-only — read via `getState()` in async
 * callbacks, stream handlers, and effects. No field here drives
 * React re-renders directly; consumers that need reactive reads
 * (none currently expected) can subscribe via `.use.*` selectors.
 *
 * `streamEpoch` is a monotonic counter bumped on every SSE lifecycle
 * transition (subscribe, unsubscribe, reconnect, cancel). In-flight
 * async work captures the epoch at dispatch time and compares against
 * the current value to detect staleness.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { EventStream } from "@/lib/streaming/stream-transport";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamContext {
  assistantId: string;
  conversationId: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface StreamStoreState {
  /** SSE connection presence bit. Non-null while the bus subscription
   *  is live for the current conversation context. `use-send-message`
   *  reads it to decide whether SSE will deliver the response or
   *  polling is needed. */
  stream: EventStream | null;

  /** Monotonic counter bumped on every SSE lifecycle transition.
   *  In-flight async work captures the epoch at dispatch time and
   *  compares against the current value to detect staleness. */
  streamEpoch: number;

  /** Assistant + conversation anchor for the active SSE subscription.
   *  Null when no subscription is live. */
  streamContext: StreamContext | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface StreamStoreActions {
  setStream: (stream: EventStream | null) => void;

  /** Increment the epoch counter and return the new value. */
  bumpEpoch: () => number;

  setStreamContext: (ctx: StreamContext | null) => void;

  /** Cancel the active stream (if any), clear presence + context,
   *  and bump the epoch. Used by error handlers to tear down a
   *  failed connection. */
  cancelAndClearStream: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type StreamStore = StreamStoreState & StreamStoreActions;

const useStreamStoreBase = create<StreamStore>((set, get) => ({
  // --- State ---
  stream: null,
  streamEpoch: 0,
  streamContext: null,

  // --- Actions ---
  setStream: (stream) => set({ stream }),

  bumpEpoch: () => {
    const next = get().streamEpoch + 1;
    set({ streamEpoch: next });
    return next;
  },

  setStreamContext: (ctx) => set({ streamContext: ctx }),

  cancelAndClearStream: () => {
    const { stream, streamEpoch } = get();
    stream?.cancel();
    set({
      stream: null,
      streamContext: null,
      streamEpoch: streamEpoch + 1,
    });
  },
}));

export const useStreamStore = createSelectors(useStreamStoreBase);
