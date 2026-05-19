
import { useSyncExternalStore } from "react";

/**
 * Minimal module-level store tracking whether the always-on SSE stream is
 * currently connected. Implemented as a plain JS observable so it can be read
 * both inside React (via `useSSEConnectedStore`) and outside the render cycle
 * (via `getSSEConnectedSnapshot`) — for example from push notification event
 * handlers that need to decide whether to suppress an OS banner.
 */

type Listener = () => void;

interface SSEConnectedState {
  isConnected: boolean;
}

let state: SSEConnectedState = { isConnected: false };
const listeners = new Set<Listener>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return state.isConnected;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Compatibility shim that mirrors the Zustand `create()` store shape so
 * consumers can call `useSSEConnectedStore.getState()` in the same style
 * as a real Zustand store, and the hook form works via `useSyncExternalStore`.
 */
function useSSEConnectedStoreHook(): SSEConnectedState {
  const isConnected = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { isConnected };
}

useSSEConnectedStoreHook.getState = (): SSEConnectedState & {
  setConnected: (value: boolean) => void;
} => ({
  ...state,
  setConnected: (value: boolean) => {
    if (state.isConnected !== value) {
      state = { isConnected: value };
      notifyListeners();
    }
  },
});

// For testing: allow resetting state
useSSEConnectedStoreHook.setState = (partial: Partial<SSEConnectedState>): void => {
  state = { ...state, ...partial };
  notifyListeners();
};

export const useSSEConnectedStore = useSSEConnectedStoreHook;

/**
 * Non-hook accessor for use in push notification event handlers (outside
 * React render cycle). Returns the current SSE connection state without
 * subscribing to updates.
 */
export const getSSEConnectedSnapshot = (): boolean => state.isConnected;
