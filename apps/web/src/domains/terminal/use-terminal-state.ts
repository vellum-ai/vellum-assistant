// TODO: port from platform
export type TerminalStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export interface TerminalState {
  status: TerminalStatus;
  sessionId: string | null;
  error: string | null;
}

export interface ConnectRequested { type: "CONNECT_REQUESTED"; sessionId: string; }
export interface ConnectSucceeded { type: "CONNECT_SUCCEEDED"; }
export interface ConnectFailed { type: "CONNECT_FAILED"; error: string; }
export interface ReconnectRequested { type: "RECONNECT_REQUESTED"; }
export interface ReconnectSucceeded { type: "RECONNECT_SUCCEEDED"; }
export interface ReconnectFailed { type: "RECONNECT_FAILED"; error: string; }
export interface Disconnected { type: "DISCONNECTED"; }
export interface ErrorOccurred { type: "ERROR_OCCURRED"; error: string; }
export interface TerminalClosed { type: "TERMINAL_CLOSED"; }
export interface TerminalReset { type: "TERMINAL_RESET"; }

export type TerminalEvent =
  | ConnectRequested | ConnectSucceeded | ConnectFailed
  | ReconnectRequested | ReconnectSucceeded | ReconnectFailed
  | Disconnected | ErrorOccurred | TerminalClosed | TerminalReset;

export const INITIAL_TERMINAL_STATE: TerminalState = { status: "idle", sessionId: null, error: null };

export function terminalReducer(state: TerminalState, _event: TerminalEvent): TerminalState {
  return state;
}

export function useTerminalState() {
  return { state: INITIAL_TERMINAL_STATE, dispatch: (_event: TerminalEvent) => {} };
}
