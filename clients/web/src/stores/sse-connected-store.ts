/**
 * Zustand store tracking whether the always-on SSE stream is currently
 * connected. Used by push notification handlers that need to decide whether
 * to suppress an OS banner (when SSE is connected, the in-app stream already
 * delivered the event).
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State & Actions
// ---------------------------------------------------------------------------

export interface SSEConnectedState {
  isConnected: boolean;
}

export interface SSEConnectedActions {
  setConnected: (value: boolean) => void;
}

export type SSEConnectedStore = SSEConnectedState & SSEConnectedActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useSSEConnectedStoreBase = create<SSEConnectedStore>()((set, get) => ({
  isConnected: false,

  setConnected: (value) => {
    if (get().isConnected !== value) {
      set({ isConnected: value });
    }
  },
}));

export const useSSEConnectedStore = createSelectors(useSSEConnectedStoreBase);

/**
 * Non-hook accessor for use outside the React render cycle (e.g. push
 * notification event handlers). Returns the current SSE connection state
 * without subscribing to updates.
 */
export const getSSEConnectedSnapshot = (): boolean =>
  useSSEConnectedStore.getState().isConnected;
