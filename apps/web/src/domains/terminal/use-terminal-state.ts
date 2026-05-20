
import { useCallback, useReducer } from "react";

import type { TerminalStatus } from "@/domains/terminal/types.js";

export type { TerminalStatus };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TerminalState {
  status: TerminalStatus;
  /** Human-readable error message when status is "error". */
  errorMessage: string | null;
  /** Number of reconnect attempts since the last successful connection. */
  reconnectAttempts: number;
  /** Opaque session ID assigned by the backend, present when connected. */
  sessionId: string | null;
}

export const INITIAL_TERMINAL_STATE: TerminalState = {
  status: "idle",
  errorMessage: null,
  reconnectAttempts: 0,
  sessionId: null,
};

// ---------------------------------------------------------------------------
// Domain events
// ---------------------------------------------------------------------------

export interface ConnectRequested {
  type: "CONNECT_REQUESTED";
}

export interface ConnectSucceeded {
  type: "CONNECT_SUCCEEDED";
  sessionId: string;
}

export interface ConnectFailed {
  type: "CONNECT_FAILED";
  message: string;
}

export interface Disconnected {
  type: "DISCONNECTED";
}

export interface ReconnectRequested {
  type: "RECONNECT_REQUESTED";
}

export interface ReconnectSucceeded {
  type: "RECONNECT_SUCCEEDED";
  sessionId: string;
}

export interface ReconnectFailed {
  type: "RECONNECT_FAILED";
  message: string;
}

export interface ErrorOccurred {
  type: "ERROR_OCCURRED";
  message: string;
}

export interface TerminalClosed {
  type: "TERMINAL_CLOSED";
}

export interface TerminalReset {
  type: "TERMINAL_RESET";
}

export type TerminalEvent =
  | ConnectRequested
  | ConnectSucceeded
  | ConnectFailed
  | Disconnected
  | ReconnectRequested
  | ReconnectSucceeded
  | ReconnectFailed
  | ErrorOccurred
  | TerminalClosed
  | TerminalReset;

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function terminalReducer(state: TerminalState, event: TerminalEvent): TerminalState {
  switch (event.type) {
    case "CONNECT_REQUESTED":
      // Only allow connecting from idle, closed, or error states.
      if (state.status === "idle" || state.status === "closed" || state.status === "error") {
        return {
          ...state,
          status: "connecting",
          errorMessage: null,
          reconnectAttempts: 0,
        };
      }
      return state;

    case "CONNECT_SUCCEEDED":
      if (state.status === "connecting") {
        return {
          ...state,
          status: "connected",
          sessionId: event.sessionId,
          errorMessage: null,
          reconnectAttempts: 0,
        };
      }
      return state;

    case "CONNECT_FAILED":
      if (state.status === "connecting") {
        return {
          ...state,
          status: "error",
          errorMessage: event.message,
          sessionId: null,
        };
      }
      return state;

    case "DISCONNECTED":
      // Unexpected drop from connected — mark as error to allow reconnect.
      if (state.status === "connected") {
        return {
          ...state,
          status: "error",
          errorMessage: "Connection lost.",
          sessionId: null,
        };
      }
      return state;

    case "RECONNECT_REQUESTED":
      // Reconnect is allowed from error or connected states.
      if (state.status === "error" || state.status === "connected") {
        return {
          ...state,
          status: "reconnecting",
          errorMessage: null,
          reconnectAttempts: state.reconnectAttempts + 1,
          sessionId: null,
        };
      }
      return state;

    case "RECONNECT_SUCCEEDED":
      if (state.status === "reconnecting") {
        return {
          ...state,
          status: "connected",
          sessionId: event.sessionId,
          errorMessage: null,
          reconnectAttempts: 0,
        };
      }
      return state;

    case "RECONNECT_FAILED":
      if (state.status === "reconnecting") {
        return {
          ...state,
          status: "error",
          errorMessage: event.message,
          sessionId: null,
        };
      }
      return state;

    case "ERROR_OCCURRED":
      return {
        ...state,
        status: "error",
        errorMessage: event.message,
        sessionId: null,
      };

    case "TERMINAL_CLOSED":
      return {
        ...state,
        status: "closed",
        errorMessage: null,
        sessionId: null,
      };

    case "TERMINAL_RESET":
      return { ...INITIAL_TERMINAL_STATE };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTerminalState() {
  const [terminalState, dispatch] = useReducer(terminalReducer, INITIAL_TERMINAL_STATE);

  const connect = useCallback(() => {
    dispatch({ type: "CONNECT_REQUESTED" });
  }, []);

  const disconnect = useCallback(() => {
    dispatch({ type: "TERMINAL_CLOSED" });
  }, []);

  const reconnect = useCallback(() => {
    dispatch({ type: "RECONNECT_REQUESTED" });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "TERMINAL_RESET" });
  }, []);

  return {
    terminalState,
    dispatch,
    connect,
    disconnect,
    reconnect,
    reset,
  };
}
