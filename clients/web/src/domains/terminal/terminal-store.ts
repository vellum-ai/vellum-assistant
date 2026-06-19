/**
 * Zustand store for terminal connection state.
 *
 * Manages the connection state machine:
 * idle → connecting → connected, with reconnect and error branches.
 * State transitions are guarded — invalid transitions are no-ops.
 *
 * Wrapped with `createSelectors` for auto-generated per-field hooks.
 *
 * @see {@link https://zustand.docs.pmnd.rs/guides/auto-generating-selectors}
 * @see {@link https://zustand.docs.pmnd.rs/guides/updating-state}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { TerminalStatus } from "@/domains/terminal/types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TerminalState {
  status: TerminalStatus;
  errorMessage: string | null;
  reconnectAttempts: number;
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface TerminalActions {
  requestConnect: () => void;
  connectSucceeded: (sessionId: string) => void;
  connectFailed: (message: string) => void;
  disconnected: () => void;
  requestReconnect: () => void;
  reconnectSucceeded: (sessionId: string) => void;
  reconnectFailed: (message: string) => void;
  errorOccurred: (message: string) => void;
  closed: () => void;
  reset: () => void;
}

export type TerminalStore = TerminalState & TerminalActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useTerminalStoreBase = create<TerminalStore>()((set, get) => ({
  status: "idle",
  errorMessage: null,
  reconnectAttempts: 0,
  sessionId: null,

  requestConnect: () => {
    const { status } = get();
    if (status === "idle" || status === "closed" || status === "error") {
      set({ status: "connecting", errorMessage: null, reconnectAttempts: 0 });
    }
  },

  connectSucceeded: (sessionId: string) => {
    if (get().status === "connecting") {
      set({ status: "connected", sessionId, errorMessage: null, reconnectAttempts: 0 });
    }
  },

  connectFailed: (message: string) => {
    if (get().status === "connecting") {
      set({ status: "error", errorMessage: message, sessionId: null });
    }
  },

  disconnected: () => {
    if (get().status === "connected") {
      set({ status: "error", errorMessage: "Connection lost.", sessionId: null });
    }
  },

  requestReconnect: () => {
    const { status, reconnectAttempts } = get();
    if (status === "error" || status === "connected") {
      set({
        status: "reconnecting",
        errorMessage: null,
        reconnectAttempts: reconnectAttempts + 1,
        sessionId: null,
      });
    }
  },

  reconnectSucceeded: (sessionId: string) => {
    if (get().status === "reconnecting") {
      set({ status: "connected", sessionId, errorMessage: null, reconnectAttempts: 0 });
    }
  },

  reconnectFailed: (message: string) => {
    if (get().status === "reconnecting") {
      set({ status: "error", errorMessage: message, sessionId: null });
    }
  },

  errorOccurred: (message: string) => {
    set({ status: "error", errorMessage: message, sessionId: null });
  },

  closed: () => {
    set({ status: "closed", errorMessage: null, sessionId: null });
  },

  reset: () => {
    set({ status: "idle", errorMessage: null, reconnectAttempts: 0, sessionId: null });
  },
}));

export const useTerminalStore = createSelectors(useTerminalStoreBase);
